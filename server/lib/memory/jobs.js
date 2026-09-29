const { getDb } = require('./db.js');
const { processConversation } = require('./summaries.js');

function createMemoryWorker({ store, getSettings, callModel } = {}) {
    let busy = false;
    let timer;
    const options = callModel ? { callModel } : {};

    function enqueue(conversationId, targetCount, { immediate = false, finalize = false } = {}) {
        const due = Date.now() + (immediate ? 0 : 45000);
        getDb().prepare(`INSERT INTO memory_jobs
            (conversation_id, target_count, finalize_requested, status, attempts, next_run_at, generation)
            VALUES (?, ?, ?, 'pending', 0, ?, 1)
            ON CONFLICT(conversation_id) DO UPDATE SET
            target_count = max(target_count, excluded.target_count),
            finalize_requested = max(finalize_requested, excluded.finalize_requested),
            status = CASE WHEN status = 'running' THEN 'running' ELSE 'pending' END,
            attempts = 0, next_run_at = min(next_run_at, excluded.next_run_at),
            generation = generation + 1`).run(conversationId, targetCount, finalize ? 1 : 0, due);
        if (immediate) setImmediate(() => { tick().catch(error => console.error('Memory worker:', error)); });
    }

    function reconcile() {
        const db = getDb();
        db.prepare("UPDATE memory_jobs SET status = 'pending' WHERE status = 'running'").run();
        for (const { id } of store.listConversations()) {
            const conversation = store.loadConversation(id);
            if (!conversation) continue;
            const row = db.prepare('SELECT message_count_at_last_summary FROM conversation_summaries WHERE conversation_id = ?').get(id);
            if (conversation.messages.length > (row?.message_count_at_last_summary || 0) &&
                conversation.messages.slice(row?.message_count_at_last_summary || 0)
                    .some(message => message.role === 'user' || message.role === 'assistant')) {
                enqueue(id, conversation.messages.length, { immediate: true, finalize: true });
            }
        }
    }

    async function tick() {
        if (busy) return;
        busy = true;
        try {
            const db = getDb();
            const job = db.prepare(`SELECT * FROM memory_jobs
                WHERE status = 'pending' AND next_run_at <= ?
                ORDER BY next_run_at LIMIT 1`).get(Date.now());
            if (!job) return;
            db.prepare("UPDATE memory_jobs SET status = 'running' WHERE conversation_id = ? AND generation = ?")
                .run(job.conversation_id, job.generation);
            try {
                const conversation = store.loadConversation(job.conversation_id);
                if (conversation) {
                    await processConversation(conversation, getSettings(), {
                        ...options, finalize: true,
                        isCurrent: () => Boolean(store.loadConversation(job.conversation_id)),
                    });
                }
                const current = db.prepare('SELECT generation FROM memory_jobs WHERE conversation_id = ?').get(job.conversation_id);
                if (!current) return;
                if (current.generation === job.generation) {
                    const latest = store.loadConversation(job.conversation_id);
                    const done = db.prepare(`SELECT message_count_at_last_summary AS count
                        FROM conversation_summaries WHERE conversation_id = ?`).get(job.conversation_id)?.count || 0;
                    if (latest && latest.messages.length > done) {
                        db.prepare("UPDATE memory_jobs SET status = 'pending', next_run_at = ? WHERE conversation_id = ?")
                            .run(Date.now(), job.conversation_id);
                    } else {
                        db.prepare('DELETE FROM memory_jobs WHERE conversation_id = ?').run(job.conversation_id);
                    }
                } else {
                    db.prepare("UPDATE memory_jobs SET status = 'pending', next_run_at = ? WHERE conversation_id = ?")
                        .run(Date.now(), job.conversation_id);
                }
            } catch (error) {
                console.error('Memory job failed:', error);
                const attempts = job.attempts + 1;
                db.prepare(`UPDATE memory_jobs SET status = ?, attempts = ?, next_run_at = ?, last_error = ?
                    WHERE conversation_id = ?`).run(attempts >= 8 ? 'failed' : 'pending',
                    attempts, Date.now() + Math.min(3600000, 30000 * 2 ** attempts),
                    String(error.message).slice(0, 500), job.conversation_id);
            }
        } finally {
            busy = false;
            if (getDb().prepare(`SELECT 1 FROM memory_jobs
                WHERE status = 'pending' AND next_run_at <= ? LIMIT 1`).get(Date.now())) {
                setImmediate(() => { tick().catch(error => console.error('Memory worker:', error)); });
            }
        }
    }

    function start() {
        reconcile();
        timer = setInterval(() => { tick().catch(error => console.error('Memory worker:', error)); }, 15000);
        timer.unref?.();
    }
    function stop() { if (timer) clearInterval(timer); }

    return { enqueue, reconcile, tick, start, stop };
}

module.exports = { createMemoryWorker };
