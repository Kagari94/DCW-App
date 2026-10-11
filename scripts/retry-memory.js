// Resume unsuccessful extraction after repairing the inference server.
// Saved facts, summaries, transcript cursors and active requests are unchanged.
async function main() {
    const { initializeMemoryDatabase, getDb } = require('../server/lib/memory/db');
    await initializeMemoryDatabase();
    try {
        const jobsResumed = require('../server/lib/memory/jobs').retryFailedMemoryJobs();
        console.log(JSON.stringify({ jobsResumed, idleDelayMs: 45000 }));
    } finally { getDb().close(); }
}
main().catch(error => { console.error(error.code || error.name); process.exitCode = 1; });
