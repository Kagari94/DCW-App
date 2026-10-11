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
    const schemaVersion = db.prepare('PRAGMA user_version').get().user_version;
    const jobs = exists('memory_jobs') ? db.prepare(
        'SELECT status, count(*) AS n FROM memory_jobs GROUP BY status').all() : [];
    const staleJobs = exists('memory_jobs') && exists('conversation_summaries') ?
        db.prepare(`SELECT count(*) AS n FROM memory_jobs j
            JOIN conversation_summaries s ON s.conversation_id = j.conversation_id
            WHERE j.target_count <= s.message_count_at_last_summary
            AND (j.finalize_requested = 0 OR s.finalized = 1)
            AND j.status != 'running'`).get().n : 0;
    const chunkIds = exists('memory_chunks') ?
        new Set(db.prepare('SELECT id FROM memory_chunks').all().map(row => Number(row.id))) : new Set();
    const orphanedLegacyVectors = exists('memory_vectors') ?
        db.prepare('SELECT rowid FROM memory_vectors').all()
            .filter(row => !chunkIds.has(Number(row.rowid))).length : 0;
    const result = {
        database: file,
        bytes: fs.statSync(file).size,
        schemaVersion,
        integrity: db.prepare('PRAGMA integrity_check').get().integrity_check,
        facts: count('facts'),
        factAliases: count('fact_aliases'),
        mergedOriginals: count('fact_merge_archive'),
        forgottenFacts: count('forgotten_facts'),
        summaries: count('conversation_summaries'),
        pendingJobs: jobs,
        failedJobs: jobs.find(row => row.status === 'failed')?.n || 0,
        oldestPendingAgeMs: schemaVersion >= 5 ? Math.max(0, Date.now() - (db.prepare(`SELECT min(first_queued_at) AS first
            FROM memory_jobs WHERE status='pending' AND first_queued_at>0`).get().first || Date.now())) : null,
        proposals: count('fact_proposals'),
        passages: count('memory_passages'),
        embeddingVersions: exists('memory_embeddings') ? db.prepare('SELECT model_id,count(*) AS n FROM memory_embeddings GROUP BY model_id').all() : [],
        recallEpoch: exists('memory_state') ? db.prepare('SELECT forget_epoch FROM memory_state WHERE id=1').get().forget_epoch : null,
        metrics: exists('memory_metrics') ? Object.fromEntries(db.prepare('SELECT name,value FROM memory_metrics').all().map(row => [row.name,row.value])) : {},
        staleJobs,
        legacyChunks: count('memory_chunks'),
        legacyVectors: count('memory_vectors'),
        orphanedLegacyVectors,
    };
    console.log(JSON.stringify(result, null, 2));
    if (result.integrity !== 'ok') process.exitCode = 1;
} finally { db.close(); }
