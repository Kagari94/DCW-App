const { statement, memoryEpoch, memoryRevision, touchMemory, onMemoryChange, metric } = require('./db.js');
const embedding = require('./embeddings.js');

// No load/download on the reply path. Only idle index work warms the optional model.
function createSemanticMemory({ embed=embedding.embedText, ready=embedding.isEmbedderReady,
    modelId=embedding.MODEL_ID, deadlineMs=150, minScore=0.65 }={}) {
    const cache=new Map();
    const unsubscribe=onMemoryChange(()=>cache.clear());
    let queryInFlight=null, retryAfter=0;
    async function indexPending() {
        if (Date.now()<retryAfter) return 0;
        const epoch=memoryEpoch();
        const rows=statement(`SELECT p.* FROM memory_passages p LEFT JOIN memory_embeddings e ON e.passage_id=p.id
            WHERE p.forget_epoch=? AND (e.passage_id IS NULL OR e.model_id!=? OR e.content_hash!=p.content_hash)
            ORDER BY p.id LIMIT 8`).all(epoch,modelId);
        let count=0;
        try {
            for (const row of rows) {
                if (require('./foreground.js').isForegroundBusy()) break;
                const started=performance.now();
                const vector=await embed(row.chunk_text);
                metric('embedding_count'); metric('embedding_ms',performance.now()-started);
                if (epoch!==memoryEpoch() || !statement('SELECT 1 FROM memory_passages WHERE id=? AND content_hash=?').get(row.id,row.content_hash)) continue;
                statement(`INSERT INTO memory_embeddings VALUES (?,?,?,?) ON CONFLICT(passage_id)
                    DO UPDATE SET model_id=excluded.model_id,content_hash=excluded.content_hash,embedding=excluded.embedding`)
                    .run(row.id,modelId,row.content_hash,Buffer.from(new Float32Array(vector).buffer));
                count++;
            }
            if (count) touchMemory();
            return count;
        } catch { retryAfter=Date.now()+60000; metric('embedding_failures'); return count; }
    }
    async function recall(text, currentId, scope, lexicalIds=[]) {
        if (!ready()) return [];
        const revision=memoryRevision(), epoch=memoryEpoch();
        const key=JSON.stringify([revision,scope,currentId,text,lexicalIds]);
        const cached=cache.get(key);
        if (cached) return cached;
        if (queryInFlight) return [];
        const started=performance.now();
        queryInFlight=(async()=>{
            const query=await embed(text);
            metric('semantic_query_count'); metric('semantic_query_ms',performance.now()-started);
            if (revision!==memoryRevision() || epoch!==memoryEpoch()) return [];
            const rows=statement(`SELECT p.*,e.embedding FROM memory_embeddings e JOIN memory_passages p ON p.id=e.passage_id
                WHERE e.model_id=? AND e.content_hash=p.content_hash AND p.forget_epoch=? AND p.character_id=?
                AND p.conversation_id!=? ORDER BY p.id DESC LIMIT 10000`).all(modelId,epoch,scope,currentId || '');
            const norm=Math.hypot(...query);
            const scored=[];
            for (const [index,row] of rows.entries()) {
                if (index%100===0 && performance.now()-started>=deadlineMs) return [];
                const bytes=row.embedding;
                const vector=new Float32Array(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
                if (vector.length!==query.length || !norm) continue;
                let dot=0, length=0;
                for (let i=0;i<vector.length;i++) { dot+=query[i]*vector[i]; length+=vector[i]*vector[i]; }
                const score=dot/(norm*Math.sqrt(length) || 1);
                if (score>=minScore) scored.push({ ...row,score });
            }
            scored.sort((a,b)=>b.score-a.score);
            const ranked=scored.slice(0,30).map((row,index)=>({
                ...row,fused:1/(60+index+1)+(lexicalIds.includes(row.id) ? 1/(60+lexicalIds.indexOf(row.id)+1):0),
            })).sort((a,b)=>b.fused-a.fused);
            const result=ranked.map(({ embedding: _vector,...row })=>row);
            cache.set(key,result);
            while (cache.size>32) cache.delete(cache.keys().next().value);
            return result;
        })().finally(()=>{ queryInFlight=null; });
        let timer;
        try {
            return await Promise.race([queryInFlight,new Promise(resolve=>{ timer=setTimeout(()=>resolve([]),deadlineMs); })]);
        } finally { clearTimeout(timer); }
    }
    return { indexPending,recall,stop:unsubscribe };
}
module.exports={ ...createSemanticMemory(),createSemanticMemory };
