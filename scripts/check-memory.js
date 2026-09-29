const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const file = process.env.COMPANION_MEMORY_DB_PATH ||
    path.join(__dirname, '../server/data/memory.db');
if (!fs.existsSync(file)) {
    console.log(JSON.stringify({ database: file, status: 'not created yet' }, null, 2));
    process.exit(0);
}
const db = new DatabaseSync(file, { readOnly: true, allowExtension: true });
try {
    const exists = name => Boolean(db.prepare(
        "SELECT 1 FROM sqlite_master WHERE name = ?").get(name));
    if (exists('memory_vectors')) require('sqlite-vec').load(db);
    const count = table => exists(table) ? db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n : 0;
    const jobs = exists('memory_jobs') ? db.prepare(
        'SELECT status, count(*) AS n FROM memory_jobs GROUP BY status').all() : [];
    const staleJobs = exists('memory_jobs') && exists('conversation_summaries') ?
        db.prepare(`SELECT count(*) AS n FROM memory_jobs j
            JOIN conversation_summaries s ON s.conversation_id = j.conversation_id
            WHERE j.target_count <= s.message_count_at_last_summary
            AND j.status != 'running'`).get().n : 0;
    const chunkIds = exists('memory_chunks') ?
        new Set(db.prepare('SELECT id FROM memory_chunks').all().map(row => Number(row.id))) : new Set();
    const orphanedLegacyVectors = exists('memory_vectors') ?
        db.prepare('SELECT rowid FROM memory_vectors').all()
            .filter(row => !chunkIds.has(Number(row.rowid))).length : 0;
    const result = {
        database: file,
        bytes: fs.statSync(file).size,
        schemaVersion: db.prepare('PRAGMA user_version').get().user_version,
        integrity: db.prepare('PRAGMA integrity_check').get().integrity_check,
        facts: count('facts'),
        factAliases: count('fact_aliases'),
        mergedOriginals: count('fact_merge_archive'),
        forgottenFacts: count('forgotten_facts'),
        summaries: count('conversation_summaries'),
        pendingJobs: jobs,
        staleJobs,
        legacyChunks: count('memory_chunks'),
        legacyVectors: count('memory_vectors'),
        orphanedLegacyVectors,
    };
    console.log(JSON.stringify(result, null, 2));
    if (result.integrity !== 'ok') process.exitCode = 1;
} finally { db.close(); }
