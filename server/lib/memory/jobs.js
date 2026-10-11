const { getDb, statement, metric, flushMetrics } = require('./db.js');
const { processConversation } = require('./summaries.js');
const { isForegroundBusy, tryBeginBackground } = require('./foreground.js');
const IDLE_MS=45000, MAX_WAIT_MS=300000, POLL_MS=15000;

function retryFailedMemoryJobs(now=Date.now()) {
    // Retry only unsuccessful work. Retain targets, priority and transcript cursors;
    // an active request or a healthy pending job must keep its existing state.
    return statement(`UPDATE memory_jobs SET status='pending',attempts=0,last_error=NULL,
        next_run_at=?,first_queued_at=?,generation=generation+1
        WHERE status IN ('failed','pending') AND (status='failed' OR attempts>0)`)
        .run(now+IDLE_MS,now).changes;
}

function createMemoryWorker({ store, getSettings, callModel, now=Date.now, foregroundBusy=isForegroundBusy }={}) {
    let busy=false, timer, stopped=false, retryAfterCurrent=false;
    const options=callModel ? { callModel } : {};
    function enqueue(id, count, { immediate=false, finalize=false }={}) {
        const previous=statement('SELECT * FROM memory_jobs WHERE conversation_id=?').get(id);
        if (previous && count <= previous.target_count && (!finalize || previous.finalize_requested) &&
            (!immediate || previous.urgent)) return;
        const time=now(), first=previous?.first_queued_at || time;
        const urgent=immediate || Boolean(previous?.urgent);
        const freshFailure=previous?.status==='failed' && count > previous.target_count;
        const attempts=freshFailure ? 0 : (previous?.attempts || 0);
        const due=attempts ? previous.next_run_at : urgent ? time : Math.min(time+IDLE_MS,first+MAX_WAIT_MS);
        statement(`INSERT INTO memory_jobs
            (conversation_id,target_count,finalize_requested,status,attempts,next_run_at,generation,first_queued_at,urgent)
            VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(conversation_id) DO UPDATE SET
            target_count=excluded.target_count,finalize_requested=excluded.finalize_requested,status=excluded.status,
            attempts=excluded.attempts,next_run_at=excluded.next_run_at,generation=excluded.generation,
            first_queued_at=excluded.first_queued_at,urgent=excluded.urgent`)
            .run(id,Math.max(count,previous?.target_count || 0),finalize ? 1 : (count > (previous?.target_count || 0) ? 0 : previous?.finalize_requested || 0),
                previous?.status==='running' ? 'running' : previous?.status==='failed' && !freshFailure ? 'failed' : 'pending',
                attempts,due,(previous?.generation || 0)+1,first,urgent ? 1 : 0);
        if (immediate && !stopped) schedule();
    }
    function reconcile() {
        const snapshot=statement('SELECT needs_forget_snapshot FROM memory_state WHERE id=1').get().needs_forget_snapshot;
        getDb().exec("UPDATE memory_jobs SET status='pending' WHERE status='running'");
        for (const { id, characterId, messageCount } of store.listConversations()) {
            if (characterId) statement(`UPDATE conversation_summaries SET character_id=?
                WHERE conversation_id=? AND character_id='__legacy__'`).run(characterId,id);
            const row=statement('SELECT message_count_at_last_summary AS count FROM conversation_summaries WHERE conversation_id=?').get(id);
            if (snapshot && messageCount !== undefined) statement('INSERT OR IGNORE INTO memory_forget_boundaries VALUES (?,?)').run(id,messageCount);
            if (messageCount !== undefined && messageCount <= (row?.count || 0)) continue;
            const conversation=store.loadConversation(id);
            if (!conversation) continue;
            if (snapshot) statement('INSERT OR IGNORE INTO memory_forget_boundaries VALUES (?,?)').run(id,conversation.messages.length);
            if (conversation.characterId) statement(`UPDATE conversation_summaries SET character_id=?
                WHERE conversation_id=? AND character_id='__legacy__'`).run(conversation.characterId,id);
            if (conversation.pendingTurn) continue;
            if (conversation.messages.length > (row?.count || 0) &&
                conversation.messages.slice(row?.count || 0).some(message=>['user','assistant'].includes(message.role)) &&
                !statement('SELECT 1 FROM memory_jobs WHERE conversation_id=?').get(id)) {
                enqueue(id,conversation.messages.length,{ immediate:true,finalize:true });
            }
        }
        if (snapshot) getDb().exec('UPDATE memory_state SET needs_forget_snapshot=0 WHERE id=1');
    }
    function schedule() {
        setImmediate(()=>{ if (!stopped) tick().catch(()=>metric('worker_failures')); });
    }
    async function tick() {
        if (busy || stopped || foregroundBusy()) return;
        const lease = tryBeginBackground();
        if (!lease) return;
        busy=true;
        let progressed=false;
        try {
            const job=statement(`SELECT * FROM memory_jobs WHERE status='pending' AND next_run_at<=?
                ORDER BY urgent DESC,next_run_at LIMIT 1`).get(now());
            if (!job) {
                if (process.env.COMPANION_MEMORY_SEMANTIC==='1') await require('./semantic.js').indexPending();
                return;
            }
            statement("UPDATE memory_jobs SET status='running' WHERE conversation_id=? AND generation=?").run(job.conversation_id,job.generation);
            try {
                const conversation=store.loadConversation(job.conversation_id);
                if (conversation && !conversation.pendingTurn) progressed=await processConversation(conversation,getSettings(),{
                    ...options,flush:true,finalize:Boolean(job.finalize_requested),
                    callModel: (messages, config) => (callModel || require('./llmClient').callLlm)(messages, config, { signal: lease.signal }),
                    isCurrent:chunk=>{
                        const latest=store.loadConversation(job.conversation_id);
                        const first=chunk?.pieces?.[0]?.index || 0;
                        const end=chunk ? chunk.index+(chunk.offset ? 1 : 0) : conversation.messages.length;
                        return Boolean(!lease.signal.aborted && latest && statement('SELECT 1 FROM memory_jobs WHERE conversation_id=?').get(job.conversation_id) &&
                            JSON.stringify(latest.messages.slice(first,end))===JSON.stringify(conversation.messages.slice(first,end)));
                    },
                });
                const current=statement('SELECT * FROM memory_jobs WHERE conversation_id=?').get(job.conversation_id);
                if (!current) return;
                const latest=store.loadConversation(job.conversation_id);
                const done=statement('SELECT message_count_at_last_summary AS count FROM conversation_summaries WHERE conversation_id=?').get(job.conversation_id)?.count || 0;
                if (!latest || (!latest.pendingTurn && latest.messages.length <= done && current.generation===job.generation)) {
                    statement('DELETE FROM memory_jobs WHERE conversation_id=?').run(job.conversation_id);
                } else {
                    const due=current.generation!==job.generation ? Math.max(now(),current.next_run_at) :
                        now()+(progressed ? 0 : POLL_MS);
                    statement("UPDATE memory_jobs SET status='pending',next_run_at=? WHERE conversation_id=?")
                        .run(due,job.conversation_id);
                }
            } catch (error) {
                if (lease.signal.aborted) {
                    statement("UPDATE memory_jobs SET status='pending',next_run_at=? WHERE conversation_id=? AND status='running'")
                        .run(now()+IDLE_MS,job.conversation_id);
                    return;
                }
                const attempts=job.attempts+1;
                // A late failure cannot reset newer work or resurrect a deleted job.
                const changed=statement(`UPDATE memory_jobs SET status=?,attempts=?,next_run_at=?,last_error=?
                    WHERE conversation_id=? AND generation=?`).run(attempts>=8 ? 'failed':'pending',attempts,
                        now()+Math.min(3600000,30000*2**attempts),String(error.code || error.name || 'MemoryError'),
                        job.conversation_id,job.generation).changes;
                if (!changed) statement("UPDATE memory_jobs SET status='pending' WHERE conversation_id=? AND status='running'")
                    .run(job.conversation_id);
                metric('job_failures');
            }
        } finally {
            lease.release();
            busy=false;
            if (retryAfterCurrent) { retryAfterCurrent=false; retryFailedMemoryJobs(now()); }
            if (!foregroundBusy()) flushMetrics();
            if (progressed && !stopped && !foregroundBusy() && statement(`SELECT 1 FROM memory_jobs
                WHERE status='pending' AND next_run_at<=? LIMIT 1`).get(now())) schedule();
        }
    }
    function start() {
        if (timer) return;
        stopped=false; reconcile();
        timer=setInterval(()=>{ tick().catch(()=>metric('worker_failures')); },POLL_MS);
        timer.unref?.();
        schedule();
    }
    function stop() { stopped=true; if (timer) clearInterval(timer); timer=undefined; flushMetrics(); }
    function retryFailed() {
        if (busy) retryAfterCurrent=true;
        return retryFailedMemoryJobs(now());
    }
    return { enqueue,reconcile,tick,start,stop,retryFailed };
}
module.exports={ createMemoryWorker,retryFailedMemoryJobs,IDLE_MS,MAX_WAIT_MS };
