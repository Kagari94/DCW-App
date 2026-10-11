const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync, backup } = require('node:sqlite');
const { consolidateDuplicateFacts } = require('./factIdentity.js');

const DB_PATH = process.env.COMPANION_MEMORY_DB_PATH || path.join(__dirname, '../../data/memory.db');
const SCHEMA_VERSION = 5;
let db;
let opening;
let legacyVectorsLoaded = false;
const statements = new Map();
const memoryListeners = new Set();
const pendingMetrics = new Map();

function statement(sql) {
    if (!statements.has(sql)) statements.set(sql, getDb().prepare(sql));
    return statements.get(sql);
}

function memoryEpoch() { return statement('SELECT forget_epoch FROM memory_state WHERE id = 1').get().forget_epoch; }
function memoryRevision() { return statement('SELECT revision FROM memory_state WHERE id = 1').get().revision; }
function touchMemory() {
    statement('UPDATE memory_state SET revision = revision + 1 WHERE id = 1').run();
    for (const listener of memoryListeners) listener();
}
function onMemoryChange(listener) { memoryListeners.add(listener); return () => memoryListeners.delete(listener); }
function metric(name, amount = 1) {
    pendingMetrics.set(name, (pendingMetrics.get(name) || 0) + amount);
}
function flushMetrics() {
    if (!pendingMetrics.size) return;
    getDb().exec('SAVEPOINT metrics_flush');
    try {
        for (const [name, amount] of pendingMetrics) statement(`INSERT INTO memory_metrics (name, value) VALUES (?, ?)
            ON CONFLICT(name) DO UPDATE SET value = value + excluded.value`).run(name, amount);
        getDb().exec('RELEASE metrics_flush');
        pendingMetrics.clear();
    } catch (error) { getDb().exec('ROLLBACK TO metrics_flush'); getDb().exec('RELEASE metrics_flush'); throw error; }
}

function addColumn(connection, table, name, type) {
    if (!connection.prepare(`PRAGMA table_info(${table})`).all().some(column => column.name === name)) {
        connection.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    }
}

function addSearchIndex(connection, table, name, columns) {
    if (tableExists(name)) return;
    const fields = columns.join(', ');
    const oldFields = columns.map(column => `old.${column}`).join(', ');
    const newFields = columns.map(column => `new.${column}`).join(', ');
    connection.exec(`CREATE VIRTUAL TABLE ${name} USING fts5(${fields}, content='${table}', content_rowid='id');
        CREATE TRIGGER ${name}_ai AFTER INSERT ON ${table} BEGIN
            INSERT INTO ${name}(rowid, ${fields}) VALUES (new.id, ${newFields}); END;
        CREATE TRIGGER ${name}_ad AFTER DELETE ON ${table} BEGIN
            INSERT INTO ${name}(${name}, rowid, ${fields}) VALUES ('delete', old.id, ${oldFields}); END;
        CREATE TRIGGER ${name}_au AFTER UPDATE ON ${table} BEGIN
            INSERT INTO ${name}(${name}, rowid, ${fields}) VALUES ('delete', old.id, ${oldFields});
            INSERT INTO ${name}(rowid, ${fields}) VALUES (new.id, ${newFields}); END;
        INSERT INTO ${name}(${name}) VALUES ('rebuild');`);
}

function tableExists(name) {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(name));
}

function loadLegacyVectors() {
    if (!legacyVectorsLoaded && tableExists('memory_vectors')) {
        require('sqlite-vec').load(db);
        legacyVectorsLoaded = true;
    }
}

async function initializeMemoryDatabase() {
    if (db) return db;
    if (opening) return opening;
    opening = (async () => {
        fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
        const existed = fs.existsSync(DB_PATH);
        const connection = new DatabaseSync(DB_PATH, { allowExtension: true });
        db = connection;
        try {
            const version = connection.prepare('PRAGMA user_version').get().user_version;
            if (version > SCHEMA_VERSION) throw new Error(`Memory database version ${version} is newer than this app`);
            if (version < SCHEMA_VERSION && existed) {
                const copy = `${DB_PATH}.pre-v${SCHEMA_VERSION}-${Date.now()}.bak`;
                await backup(connection, copy);
                console.log(`Memory backup created: ${copy}`);
            }
            const priorFacts = tableExists('facts') ?
                connection.prepare('SELECT count(*) AS n FROM facts').get().n : 0;
            const priorSummaries = tableExists('conversation_summaries') ?
                connection.prepare('SELECT count(*) AS n FROM conversation_summaries').get().n : 0;
            connection.exec('BEGIN IMMEDIATE');
            try {
                connection.exec(`
                    CREATE TABLE IF NOT EXISTS facts (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        category TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
                        source_conversation_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                        UNIQUE(category, key)
                    );
                    CREATE TABLE IF NOT EXISTS fact_revisions (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        fact_id INTEGER NOT NULL, value TEXT NOT NULL,
                        source_conversation_id TEXT, changed_at TEXT NOT NULL
                    );
                    CREATE TABLE IF NOT EXISTS forgotten_facts (
                        category TEXT NOT NULL, key TEXT NOT NULL,
                        forgotten_at TEXT NOT NULL, PRIMARY KEY (category, key)
                    );
                    CREATE TABLE IF NOT EXISTS fact_aliases (
                        category TEXT NOT NULL, key TEXT NOT NULL, fact_id INTEGER NOT NULL,
                        PRIMARY KEY (category, key)
                    );
                    CREATE INDEX IF NOT EXISTS fact_aliases_fact ON fact_aliases(fact_id);
                    CREATE TABLE IF NOT EXISTS fact_merge_archive (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        fact_id INTEGER NOT NULL, original_fact TEXT NOT NULL, merged_at TEXT NOT NULL
                    );
                    CREATE TABLE IF NOT EXISTS conversation_summaries (
                        conversation_id TEXT PRIMARY KEY, rolling_summary TEXT, final_summary TEXT,
                        message_count_at_last_summary INTEGER NOT NULL DEFAULT 0,
                        message_offset_at_last_summary INTEGER NOT NULL DEFAULT 0,
                        finalized INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
                    );
                    CREATE TABLE IF NOT EXISTS memory_jobs (
                        conversation_id TEXT PRIMARY KEY, target_count INTEGER NOT NULL,
                        finalize_requested INTEGER NOT NULL DEFAULT 0,
                        status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
                        next_run_at INTEGER NOT NULL, generation INTEGER NOT NULL DEFAULT 0,
                        last_error TEXT
                    );
                `);
                const factColumns = connection.prepare('PRAGMA table_info(facts)').all().map(column => column.name);
                if (!factColumns.includes('pinned')) connection.exec('ALTER TABLE facts ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0');
                if (!factColumns.includes('source_kind')) connection.exec("ALTER TABLE facts ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'automatic'");
                const summaryColumns = connection.prepare('PRAGMA table_info(conversation_summaries)').all().map(column => column.name);
                if (!summaryColumns.includes('message_offset_at_last_summary')) {
                    connection.exec('ALTER TABLE conversation_summaries ADD COLUMN message_offset_at_last_summary INTEGER NOT NULL DEFAULT 0');
                }
                if (!tableExists('summary_fts')) {
                    connection.exec(`
                        CREATE VIRTUAL TABLE summary_fts USING fts5(
                            final_summary, content='conversation_summaries', content_rowid='rowid'
                        );
                        CREATE TRIGGER summary_fts_ai AFTER INSERT ON conversation_summaries BEGIN
                            INSERT INTO summary_fts(rowid, final_summary) VALUES (new.rowid, new.final_summary);
                        END;
                        CREATE TRIGGER summary_fts_ad AFTER DELETE ON conversation_summaries BEGIN
                            INSERT INTO summary_fts(summary_fts, rowid, final_summary)
                            VALUES ('delete', old.rowid, old.final_summary);
                        END;
                        CREATE TRIGGER summary_fts_au AFTER UPDATE OF final_summary ON conversation_summaries BEGIN
                            INSERT INTO summary_fts(summary_fts, rowid, final_summary)
                            VALUES ('delete', old.rowid, old.final_summary);
                            INSERT INTO summary_fts(rowid, final_summary) VALUES (new.rowid, new.final_summary);
                        END;
                        INSERT INTO summary_fts(summary_fts) VALUES ('rebuild');
                    `);
                }
                if (connection.prepare('SELECT count(*) AS n FROM facts').get().n !== priorFacts ||
                    connection.prepare('SELECT count(*) AS n FROM conversation_summaries').get().n !== priorSummaries) {
                    throw new Error('Memory migration changed existing row counts');
                }
                if (version < 4) {
                    const merged = consolidateDuplicateFacts(connection);
                    if (connection.prepare('SELECT count(*) AS n FROM facts').get().n + merged !== priorFacts) {
                        throw new Error('Memory consolidation changed unexpected row counts');
                    }
                    if (merged) console.log(`Merged ${merged} duplicate memory facts; originals retained`);
                }
                if (version < 5) {
                    const { topicIdentity, normalizedValue } = require('./factIdentity.js');
                    for (const table of ['facts', 'fact_aliases', 'forgotten_facts']) {
                        addColumn(connection, table, 'topic_identity', "TEXT NOT NULL DEFAULT ''");
                        const update = connection.prepare(`UPDATE ${table} SET topic_identity = ? WHERE category = ? AND key = ?`);
                        for (const row of connection.prepare(`SELECT category, key FROM ${table}`).all()) {
                            update.run(topicIdentity(row.key), row.category, row.key);
                        }
                        connection.exec(`CREATE INDEX ${table}_topic ON ${table}(category, topic_identity)`);
                    }
                    addColumn(connection, 'facts', 'normalized_value', "TEXT NOT NULL DEFAULT ''");
                    addColumn(connection, 'facts', 'source_message_index', 'INTEGER');
                    addColumn(connection, 'facts', 'source_quote', 'TEXT');
                    addColumn(connection, 'fact_revisions', 'source_message_index', 'INTEGER');
                    addColumn(connection, 'fact_revisions', 'source_quote', 'TEXT');
                    for (const row of connection.prepare('SELECT id, value FROM facts').all()) {
                        connection.prepare('UPDATE facts SET normalized_value = ? WHERE id = ?').run(normalizedValue(row.value), row.id);
                    }
                    addColumn(connection, 'conversation_summaries', 'character_id', "TEXT NOT NULL DEFAULT '__legacy__'");
                    addColumn(connection, 'conversation_summaries', 'forget_epoch', 'INTEGER NOT NULL DEFAULT 0');
                    addColumn(connection, 'memory_jobs', 'first_queued_at', 'INTEGER NOT NULL DEFAULT 0');
                    addColumn(connection, 'memory_jobs', 'urgent', 'INTEGER NOT NULL DEFAULT 0');
                    connection.exec(`CREATE INDEX facts_priority ON facts(pinned DESC, category, updated_at DESC);
                        CREATE INDEX forgotten_topic ON forgotten_facts(topic_identity);
                        CREATE INDEX jobs_due ON memory_jobs(status, next_run_at);
                        CREATE TABLE memory_state(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL DEFAULT 0,
                            forget_epoch INTEGER NOT NULL DEFAULT 0, needs_forget_snapshot INTEGER NOT NULL DEFAULT 0);
                        INSERT INTO memory_state(id) VALUES (1);
                        CREATE TABLE memory_metrics(name TEXT PRIMARY KEY, value REAL NOT NULL);
                        CREATE TABLE fact_proposals(id INTEGER PRIMARY KEY AUTOINCREMENT, fact_id INTEGER NOT NULL,
                            value TEXT NOT NULL, normalized_value TEXT NOT NULL, source_conversation_id TEXT,
                            source_message_index INTEGER, source_quote TEXT, created_at TEXT NOT NULL,
                            status TEXT NOT NULL DEFAULT 'pending', UNIQUE(fact_id, normalized_value));
                        CREATE INDEX proposals_fact ON fact_proposals(fact_id, status);
                        CREATE TABLE forgotten_evidence(hash TEXT PRIMARY KEY, topic_identity TEXT NOT NULL);
                        CREATE TABLE memory_forget_boundaries(conversation_id TEXT PRIMARY KEY, message_count INTEGER NOT NULL);
                        CREATE TABLE memory_passages(id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL,
                            character_id TEXT NOT NULL, start_index INTEGER NOT NULL, start_offset INTEGER NOT NULL,
                            end_index INTEGER NOT NULL, chunk_text TEXT NOT NULL, topics_json TEXT NOT NULL DEFAULT '[]',
                            forget_epoch INTEGER NOT NULL, content_hash TEXT NOT NULL, updated_at TEXT NOT NULL,
                            UNIQUE(conversation_id, start_index, start_offset));
                        CREATE INDEX passages_scope ON memory_passages(character_id, forget_epoch, conversation_id);
                        CREATE TABLE memory_embeddings(passage_id INTEGER PRIMARY KEY, model_id TEXT NOT NULL,
                            content_hash TEXT NOT NULL, embedding BLOB NOT NULL);`);
                    addSearchIndex(connection, 'facts', 'facts_fts', ['key', 'value']);
                    addSearchIndex(connection, 'memory_passages', 'passage_fts', ['chunk_text']);
                    // Historical episodes are unverified after any earlier Forget.
                    if (connection.prepare('SELECT count(*) AS n FROM forgotten_facts').get().n) {
                        connection.exec('UPDATE memory_state SET forget_epoch = 1, needs_forget_snapshot = 1');
                    }
                }
                connection.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
                connection.exec('COMMIT');
            } catch (error) { connection.exec('ROLLBACK'); throw error; }
            return connection;
        } catch (error) {
            connection.close();
            db = undefined;
            statements.clear();
            throw error;
        }
    })();
    try { return await opening; }
    finally { opening = undefined; }
}

function getDb() {
    if (!db) throw new Error('Memory database has not been initialized');
    return db;
}

function deleteConversationMemory(conversationId) {
    const connection = getDb();
    loadLegacyVectors();
    connection.exec('BEGIN IMMEDIATE');
    try {
        connection.prepare('DELETE FROM memory_jobs WHERE conversation_id = ?').run(conversationId);
        connection.prepare('DELETE FROM conversation_summaries WHERE conversation_id = ?').run(conversationId);
        connection.prepare(`DELETE FROM memory_embeddings WHERE passage_id IN
            (SELECT id FROM memory_passages WHERE conversation_id = ?)`).run(conversationId);
        connection.prepare('DELETE FROM memory_passages WHERE conversation_id = ?').run(conversationId);
        if (tableExists('memory_chunks')) {
            const ids = connection.prepare('SELECT id FROM memory_chunks WHERE conversation_id = ?').all(conversationId);
            if (legacyVectorsLoaded) {
                const removeVector = connection.prepare('DELETE FROM memory_vectors WHERE rowid = ?');
                for (const { id } of ids) removeVector.run(id);
            }
            connection.prepare('DELETE FROM memory_chunks WHERE conversation_id = ?').run(conversationId);
        }
        // User profile facts intentionally survive conversation deletion.
        touchMemory();
        connection.exec('COMMIT');
    } catch (error) { connection.exec('ROLLBACK'); throw error; }
}

module.exports = { initializeMemoryDatabase, getDb, statement, memoryEpoch, memoryRevision,
    touchMemory, onMemoryChange, metric, flushMetrics, deleteConversationMemory, DB_PATH, SCHEMA_VERSION };
