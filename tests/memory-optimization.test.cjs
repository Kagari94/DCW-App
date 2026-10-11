const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('memory optimization preserves authority, privacy, scope and low-cost scheduling', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-memory-optimization-'));
    process.env.COMPANION_MEMORY_DB_PATH = path.join(directory, 'memory.db');
    const memoryDb = require('../server/lib/memory/db');
    await memoryDb.initializeMemoryDatabase();
    const db = memoryDb.getDb();
    t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    const facts = require('../server/lib/memory/facts');
    const { processConversation, getSummaryRow } = require('../server/lib/memory/summaries');
    const { retrieveRelevantChunks, shouldRetrieve } = require('../server/lib/memory/retrieval');
    const { createMemoryWorker, retryFailedMemoryJobs, IDLE_MS, MAX_WAIT_MS } = require('../server/lib/memory/jobs');
    const conversations = new Map();
    const store = {
        listConversations: () => [...conversations.keys()].map(id => ({ id })),
        loadConversation: id => conversations.has(id) ? structuredClone(conversations.get(id)) : null,
    };
    function conversation(id, text, characterId='character-a') {
        const value = { id, characterId, messages: [{ role: 'user', content: text }, { role: 'assistant', content: 'Understood.' }] };
        conversations.set(id,value);
        return value;
    }
    const emptyModel = async () => JSON.stringify({ summary: 'A companion conversation.', facts: [] });

    await t.test('idle debounce, bounded postponement, foreground priority and small-batch flush', async t => {
        let now = 100000, busy = false, calls = 0;
        const chat = conversation('debounce', 'I enjoy walking in forests.');
        const worker = createMemoryWorker({ store, now: () => now, foregroundBusy: () => busy,
            getSettings: () => ({}), callModel: async () => { calls++; return emptyModel(); } });
        t.after(() => { worker.stop(); db.exec('DELETE FROM memory_jobs'); });
        worker.enqueue(chat.id,2);
        now += 20000;
        chat.messages.push({ role: 'user', content: 'The forest is peaceful.' });
        worker.enqueue(chat.id,3);
        assert.equal(db.prepare('SELECT next_run_at FROM memory_jobs WHERE conversation_id=?').get(chat.id).next_run_at,165000);
        now = 145000; await worker.tick(); assert.equal(calls,0);
        now = 165000; busy = true; await worker.tick(); assert.equal(calls,0);
        busy = false; await worker.tick(); assert.equal(calls,1);
        assert.equal(getSummaryRow(chat.id).finalized,0);
        worker.enqueue(chat.id,3,{ immediate:true,finalize:true });
        await worker.tick(); assert.equal(calls,1);
        assert.equal(getSummaryRow(chat.id).finalized,1);
        worker.reconcile(); await worker.tick(); assert.equal(calls,1);
        const bounded = conversation('bounded','I enjoy small gardens.');
        worker.enqueue(bounded.id,2);
        const first = now;
        for (let index=0; index<20; index++) { now+=20000; worker.enqueue(bounded.id,3+index); }
        assert.equal(db.prepare('SELECT next_run_at FROM memory_jobs WHERE conversation_id=?').get(bounded.id).next_run_at,first+MAX_WAIT_MS);
        db.prepare('DELETE FROM memory_jobs WHERE conversation_id=?').run(bounded.id);
        worker.start(); worker.start(); worker.stop(); worker.stop();
    });

    await t.test('backoff survives enqueue and late failure cannot overwrite a newer generation', async t => {
        let now=1000000, reject;
        const chat=conversation('retry','I prefer quiet mornings.');
        const worker=createMemoryWorker({ store,now:()=>now,foregroundBusy:()=>false,getSettings:()=>({}),
            callModel:async()=>{ throw new Error('not logged with transcript'); } });
        t.after(()=>worker.stop());
        worker.enqueue(chat.id,2);
        db.prepare('UPDATE memory_jobs SET next_run_at=0 WHERE conversation_id=?').run(chat.id);
        await worker.tick();
        const previous=db.prepare('SELECT * FROM memory_jobs WHERE conversation_id=?').get(chat.id);
        now+=1000; chat.messages.push({role:'user',content:'I also like tea.'}); worker.enqueue(chat.id,3);
        const current=db.prepare('SELECT * FROM memory_jobs WHERE conversation_id=?').get(chat.id);
        assert.equal(current.attempts,1); assert.equal(current.next_run_at,previous.next_run_at);
        assert.ok(!current.last_error || !current.last_error.includes('transcript'));
        db.prepare('DELETE FROM memory_jobs WHERE conversation_id=?').run(chat.id);
        const late=conversation('late','I need a clear schedule.');
        const delayed=createMemoryWorker({store,now:()=>now,foregroundBusy:()=>false,getSettings:()=>({}),
            callModel:()=>new Promise((resolve,fail)=>{ reject=fail; })});
        t.after(()=>delayed.stop());
        delayed.enqueue(late.id,2); db.prepare('UPDATE memory_jobs SET next_run_at=0 WHERE conversation_id=?').run(late.id);
        const running=delayed.tick();
        late.messages.push({role:'user',content:'Add a weekly break.'}); delayed.enqueue(late.id,3);
        reject(new Error('late error')); await running;
        const newer=db.prepare('SELECT * FROM memory_jobs WHERE conversation_id=?').get(late.id);
        assert.equal(newer.status,'pending'); assert.equal(newer.attempts,0);
        db.prepare('DELETE FROM memory_jobs WHERE conversation_id=?').run(late.id);
    });

    await t.test('foreground cancellation returns memory work to pending without failures or partial facts', async t => {
        const { beginForeground, tryBeginBackground } = require('../server/lib/memory/foreground');
        const chat = conversation('foreground-cancel', 'I prefer peaceful afternoons.');
        let entered;const started = new Promise(resolve => { entered = resolve; });
        const beforeFacts = facts.getAllFacts();
        const worker = createMemoryWorker({ store, getSettings: () => ({}), callModel: async (_messages, _config, { signal }) => {
            entered();await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));signal.throwIfAborted();
        } });
        t.after(() => { worker.stop();db.prepare('DELETE FROM memory_jobs WHERE conversation_id=?').run(chat.id); });
        worker.enqueue(chat.id, 2, { immediate: true });
        const work = worker.tick();await started;assert.equal(tryBeginBackground(), null);
        const finish = beginForeground();try { await work; } finally { finish(); }
        const job = db.prepare('SELECT status,attempts FROM memory_jobs WHERE conversation_id=?').get(chat.id);
        assert.equal(job.status, 'pending');assert.equal(job.attempts, 0);assert.deepEqual(facts.getAllFacts(), beforeFacts);
        assert.equal(getSummaryRow(chat.id), undefined);
    });

    await t.test('pending turns and in-flight deletion cannot save partial or resurrected memories', async t => {
        let calls=0, resolve;
        const chat=conversation('pending','I am studying astronomy.');
        chat.pendingTurn={userText:'Look at my screen'};
        const worker=createMemoryWorker({store,foregroundBusy:()=>false,getSettings:()=>({}),callModel:async()=>{calls++;return emptyModel();}});
        t.after(()=>worker.stop());
        worker.enqueue(chat.id,2); db.prepare('UPDATE memory_jobs SET next_run_at=0 WHERE conversation_id=?').run(chat.id);
        await worker.tick(); assert.equal(calls,0);
        assert.ok(db.prepare('SELECT next_run_at FROM memory_jobs WHERE conversation_id=?').get(chat.id).next_run_at>Date.now());
        db.prepare('DELETE FROM memory_jobs WHERE conversation_id=?').run(chat.id);
        const deleted=conversation('deleted','I am learning ceramics.');
        const delayed=createMemoryWorker({store,foregroundBusy:()=>false,getSettings:()=>({}),
            callModel:()=>new Promise(done=>{resolve=done;})});
        t.after(()=>delayed.stop());
        delayed.enqueue(deleted.id,2); db.prepare('UPDATE memory_jobs SET next_run_at=0 WHERE conversation_id=?').run(deleted.id);
        const running=delayed.tick();
        conversations.delete(deleted.id); memoryDb.deleteConversationMemory(deleted.id);
        resolve(await emptyModel()); await running;
        assert.equal(getSummaryRow(deleted.id),undefined);
        assert.equal(db.prepare('SELECT 1 FROM memory_jobs WHERE conversation_id=?').get(deleted.id),undefined);
    });

    await t.test('recovery resumes unsuccessful jobs without changing facts, cursors or active work', async t => {
        let now=2000000,busy=true,calls=0;
        const chat=conversation('model-recovery','I prefer jasmine tea.');
        const worker=createMemoryWorker({store,now:()=>now,foregroundBusy:()=>busy,getSettings:()=>({}),
            callModel:async()=>{calls++;return emptyModel();}});
        t.after(()=>{worker.stop();db.exec('DELETE FROM memory_jobs');});
        for (const id of [chat.id,'backoff','healthy','active']) worker.enqueue(id,2);
        db.prepare("UPDATE memory_jobs SET status='failed',attempts=8,last_error='INVALID_MODEL_OUTPUT' WHERE conversation_id=?").run(chat.id);
        db.prepare("UPDATE memory_jobs SET attempts=3,last_error='ECONNABORTED' WHERE conversation_id='backoff'").run();
        db.prepare("UPDATE memory_jobs SET status='running',attempts=2 WHERE conversation_id='active'").run();
        const healthy=db.prepare("SELECT * FROM memory_jobs WHERE conversation_id='healthy'").get();
        const active=db.prepare("SELECT * FROM memory_jobs WHERE conversation_id='active'").get();
        const beforeFacts=facts.getAllFacts(),revision=memoryDb.memoryRevision(),cursor=getSummaryRow(chat.id);
        const generation=db.prepare('SELECT generation FROM memory_jobs WHERE conversation_id=?').get(chat.id).generation;
        assert.equal(retryFailedMemoryJobs(now),2);
        const recovered=db.prepare('SELECT * FROM memory_jobs WHERE conversation_id=?').get(chat.id);
        assert.equal(recovered.status,'pending');assert.equal(recovered.attempts,0);assert.equal(recovered.last_error,null);
        assert.equal(recovered.next_run_at,now+IDLE_MS);assert.equal(recovered.generation,generation+1);
        assert.equal(recovered.target_count,2);
        assert.deepEqual(db.prepare("SELECT * FROM memory_jobs WHERE conversation_id='healthy'").get(),healthy);
        assert.deepEqual(db.prepare("SELECT * FROM memory_jobs WHERE conversation_id='active'").get(),active);
        assert.deepEqual(facts.getAllFacts(),beforeFacts);assert.equal(memoryDb.memoryRevision(),revision);
        assert.deepEqual(getSummaryRow(chat.id),cursor);assert.equal(worker.retryFailed(),0);
        now+=IDLE_MS;await worker.tick();assert.equal(calls,0);
        busy=false;await worker.tick();assert.equal(calls,1);
        assert.ok(getSummaryRow(chat.id));
        assert.equal(db.prepare('SELECT 1 FROM memory_jobs WHERE conversation_id=?').get(chat.id),undefined);
        db.exec('DELETE FROM memory_jobs');
        let reject;
        const late=conversation('old-model-in-flight','I need quiet mornings.');
        const delayed=createMemoryWorker({store,now:()=>now,foregroundBusy:()=>false,getSettings:()=>({}),
            callModel:()=>new Promise((_resolve,fail)=>{reject=fail;})});
        t.after(()=>delayed.stop());
        delayed.enqueue(late.id,2);db.prepare('UPDATE memory_jobs SET next_run_at=0 WHERE conversation_id=?').run(late.id);
        const running=delayed.tick();
        assert.equal(delayed.retryFailed(),0);
        assert.equal(db.prepare('SELECT status FROM memory_jobs WHERE conversation_id=?').get(late.id).status,'running');
        reject(new Error('Previous model failed'));await running;
        const resumed=db.prepare('SELECT * FROM memory_jobs WHERE conversation_id=?').get(late.id);
        assert.equal(resumed.status,'pending');assert.equal(resumed.attempts,0);
        assert.equal(resumed.next_run_at,now+IDLE_MS);
    });

    await t.test('only supported user declarations save facts; repeated conflicts require review', async () => {
        const malformed=conversation('malformed','I need restful sleep.');
        const revision=memoryDb.memoryRevision(),count=facts.getAllFacts().length;
        await assert.rejects(processConversation(malformed,{}, {flush:true,
            callModel:async()=>'<unused39><tool_response|>'}),SyntaxError);
        assert.equal(getSummaryRow(malformed.id),undefined);
        assert.equal(facts.getAllFacts().length,count);
        assert.equal(memoryDb.memoryRevision(),revision);
        assert.equal(db.prepare('SELECT count(*) n FROM memory_passages WHERE conversation_id=?').get(malformed.id).n,0);
        const chat=conversation('evidence','I want a red bicycle.');
        chat.messages.push({role:'user',content:'Example: "I need an expensive car."'});
        chat.messages.push({role:'user',content:'If I win the lottery, I want a private island.'});
        const result={summary:'A bicycle discussion.',facts:[
            {category:'want',key:'bicycle',value:'a red bicycle',source_message_index:0,quote:'I want a red bicycle.'},
            {category:'need',key:'car',value:'an expensive car',source_message_index:2,quote:'I need an expensive car.'},
            {category:'identity',key:'unsupported',value:'Astronaut',source_message_index:1,quote:'Understood.'},
            {category:'preference',key:'fabrication',value:'I dislike bicycles',source_message_index:0,quote:'I want a red bicycle.'},
            {category:'want',key:'island',value:'a private island',source_message_index:3,quote:'I want a private island.'},
        ]};
        await processConversation(chat,{}, {flush:true,callModel:async()=>JSON.stringify(result)});
        const saved=facts.getAllFacts().find(row=>row.key==='bicycle');
        assert.ok(saved); assert.equal(saved.source_message_index,0); assert.equal(saved.source_quote,'I want a red bicycle.');
        assert.ok(!facts.getAllFacts().some(row=>['car','unsupported','fabrication','island'].includes(row.key)));
        facts.upsertFact('want','bicycle','a green bicycle','evidence');
        facts.upsertFact('want','bicycle','A GREEN BICYCLE','evidence');
        assert.equal(facts.getAllFacts().find(row=>row.id===saved.id).value,'a red bicycle');
        const changes=facts.getProposals().filter(row=>row.fact_id===saved.id);
        assert.equal(changes.length,1);
        assert.equal(facts.resolveProposal(changes[0].id,true),true);
        assert.equal(facts.resolveProposal(changes[0].id,true),false);
        assert.equal(facts.getFactHistory(saved.id).revisions[0].value,'a red bicycle');
        facts.upsertFact('want','bicycle','a blue bicycle','evidence');
        const declined=facts.getProposals().find(row=>row.fact_id===saved.id);
        facts.resolveProposal(declined.id,false); facts.upsertFact('want','bicycle','a blue bicycle','evidence');
        assert.ok(!facts.getProposals().some(row=>row.id===declined.id));
    });

    await t.test('recall works without cues, stays within character scope, and retains older details', async () => {
        const a=conversation('scope-a','The Trek bicycle needs new brakes.');
        const b=conversation('scope-b','Basil grows on the kitchen windowsill.','character-b');
        await processConversation(a,{}, {flush:true,callModel:emptyModel});
        await processConversation(b,{}, {flush:true,callModel:emptyModel});
        assert.equal(shouldRetrieve('Trek brakes?'),true);
        assert.equal((await retrieveRelevantChunks('Trek brakes?','current',{characterId:'character-a'}))[0].conversation_id,a.id);
        assert.deepEqual(await retrieveRelevantChunks('Basil windowsill?','current',{characterId:'character-a'}),[]);
        assert.deepEqual(await retrieveRelevantChunks('Quantum volcano insurance?','current',{characterId:'character-a'}),[]);
        assert.deepEqual(await retrieveRelevantChunks('Trek brakes?',a.id,{characterId:'character-a'}),[]);
        a.messages.push({role:'user',content:'x '.repeat(2000)+'The Zephyr orchid is purple.'});
        await processConversation(a,{}, {flush:true,callModel:emptyModel});
        assert.match((await retrieveRelevantChunks('Zephyr orchid?','current',{characterId:'character-a'}))[0].chunk_text,/Zephyr orchid/);
        assert.equal((await retrieveRelevantChunks('Trek brakes?','current',{characterId:'character-a'}))[0].conversation_id,a.id);
        assert.equal(require.cache[require.resolve('../server/lib/memory/embeddings')],undefined);
        facts.upsertFact('preference','oversized','x'.repeat(500),null,'manual',true);
        facts.upsertFact('identity','short','Tea',null,'manual',true);
        assert.match(facts.getFactsText('',150),/short: Tea/);
        const context=await require('../server/lib/memory').buildMemoryContext('Trek brakes?','current',{characterId:'character-a'});
        assert.ok(Math.ceil(Buffer.byteLength(context,'utf8')/3)<=2000);
        const factCount=facts.getAllFacts().length;
        const greeting=await require('../server/lib/memory').buildMemoryContext('Good morning!','current',{characterId:'character-a'});
        assert.ok(Buffer.byteLength(greeting,'utf8')<=750);
        assert.doesNotMatch(greeting,/Historical conversation/);
        assert.match(greeting,/short: Tea/);
        assert.equal(facts.getAllFacts().length,factCount);
    });

    await t.test('Forget preserves unrelated facts and blocks history replay and in-flight extraction', async () => {
        const saved=facts.getAllFacts().find(row=>row.key==='bicycle');
        const retained=facts.getAllFacts().find(row=>row.key==='short');
        facts.forgetFact(saved.id,[...conversations.values()].map(row=>({id:row.id,count:row.messages.length})));
        assert.ok(facts.getAllFacts().some(row=>row.id===retained.id));
        assert.equal(facts.getFactHistory(saved.id).revisions.length,0);
        assert.equal(facts.upsertFact('need','bicycle','a yellow bicycle'),null);
        assert.deepEqual(await retrieveRelevantChunks('Trek brakes?','current',{characterId:'character-a'}),[]);
        const old=conversations.get('evidence');
        db.prepare('DELETE FROM conversation_summaries WHERE conversation_id=?').run(old.id);
        let calls=0;
        await processConversation(old,{}, {flush:true,callModel:async()=>{calls++;return emptyModel();}});
        assert.equal(calls,0);
        const inFlight=conversation('forget-race','I need regular sleep.');
        let resolve;
        const running=processConversation(inFlight,{}, {flush:true,callModel:()=>new Promise(done=>{resolve=done;})});
        facts.forgetFact(retained.id,[{id:inFlight.id,count:inFlight.messages.length}]);
        resolve(JSON.stringify({summary:'Sleep.',facts:[{category:'need',key:'sleep',value:'regular sleep',source_message_index:0,quote:'I need regular sleep.'}]}));
        await running;
        assert.equal(getSummaryRow(inFlight.id),undefined);
        assert.ok(!facts.getAllFacts().some(row=>row.key==='sleep'));
        assert.ok(facts.upsertFact('want','bicycle','a yellow bicycle',null,'manual'));
        const transient=facts.upsertFact('preference','lotus_meals','I enjoy Lotus meals',null,'manual');
        const semantic=require('../server/lib/memory/semantic');
        const originalRecall=semantic.recall, originalSetting=process.env.COMPANION_MEMORY_SEMANTIC;
        process.env.COMPANION_MEMORY_SEMANTIC='1';
        let changed=false;
        semantic.recall=async()=>{if (!changed) {changed=true;facts.forgetFact(transient);}return [];};
        try {
            const context=await require('../server/lib/memory').buildMemoryContext('Lotus meals?','current');
            assert.ok(!context?.includes('Lotus'));
        } finally {
            semantic.recall=originalRecall;
            if (originalSetting === undefined) delete process.env.COMPANION_MEMORY_SEMANTIC;
            else process.env.COMPANION_MEMORY_SEMANTIC=originalSetting;
        }
    });

    await t.test('semantic fallback is warm-only, versioned, scoped, bounded, and invalidated by Forget', async t => {
        const {createSemanticMemory}=require('../server/lib/memory/semantic');
        for (const [id,scope,text] of [[1,'semantic','The physician appointment is at noon.'],[2,'other','The physician appointment is at midnight.']]) {
            db.prepare(`INSERT INTO memory_passages
                (conversation_id,character_id,start_index,start_offset,end_index,chunk_text,forget_epoch,content_hash,updated_at)
                VALUES (?,?,0,0,0,?,?,?,?)`).run(`semantic-${id}`,scope,text,memoryDb.memoryEpoch(),`hash-${id}`,'2026');
        }
        let calls=0;
        const engine=createSemanticMemory({modelId:'fixture-v1',ready:()=>true,
            embed:async text=>{calls++;return /doctor|physician/.test(text) ? [1,0] : [0,1];}});
        t.after(()=>engine.stop());
        while (await engine.indexPending()) { /* synthetic vectors, no download */ }
        const rows=await engine.recall('doctor visit','current','semantic');
        assert.equal(rows[0].conversation_id,'semantic-1');
        assert.ok(rows.every(row=>row.character_id==='semantic'));
        const before=calls; await engine.recall('doctor visit','current','semantic'); assert.equal(calls,before);
        const cold=createSemanticMemory({modelId:'cold',ready:()=>false,embed:async()=>{throw new Error('must not load');}});
        t.after(()=>cold.stop()); assert.deepEqual(await cold.recall('doctor','current','semantic'),[]);
        const timed=createSemanticMemory({modelId:'fixture-v1',ready:()=>true,deadlineMs:1,
            embed:async()=>{await new Promise(resolve=>setTimeout(resolve,25));return [1,0];}});
        t.after(()=>timed.stop()); assert.deepEqual(await timed.recall('doctor','current','semantic'),[]);
        const fact=facts.getAllFacts().find(row=>row.key==='bicycle'); facts.forgetFact(fact.id);
        assert.deepEqual(await engine.recall('doctor visit','current','semantic'),[]);
        await new Promise(resolve=>setTimeout(resolve,30));
    });
});
