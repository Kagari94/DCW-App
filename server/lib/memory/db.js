const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync, backup } = require('node:sqlite');
const { consolidateDuplicateFacts } = require('./factIdentity.js');

const DB_PATH = process.env.COMPANION_MEMORY_DB_PATH || path.join(__dirname, '../../data/memory.db');
const SCHEMA_VERSION = 4;
let db;
let opening;
let legacyVectorsLoaded = false;

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
                connection.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
                connection.exec('COMMIT');
            } catch (error) { connection.exec('ROLLBACK'); throw error; }
            return connection;
        } catch (error) {
            connection.close();
            db = undefined;
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
        if (tableExists('memory_chunks')) {
            const ids = connection.prepare('SELECT id FROM memory_chunks WHERE conversation_id = ?').all(conversationId);
            if (legacyVectorsLoaded) {
                const removeVector = connection.prepare('DELETE FROM memory_vectors WHERE rowid = ?');
                for (const { id } of ids) removeVector.run(id);
            }
            connection.prepare('DELETE FROM memory_chunks WHERE conversation_id = ?').run(conversationId);
        }
        // User profile facts intentionally survive conversation deletion.
        connection.exec('COMMIT');
    } catch (error) { connection.exec('ROLLBACK'); throw error; }
}

module.exports = { initializeMemoryDatabase, getDb, deleteConversationMemory, DB_PATH };
