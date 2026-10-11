const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { assertValidModelOutput, modelOutputState } = require('../server/lib/modelOutput');
const { runWithTools } = require('../server/lib/toolCallLoop');
const { callLlm, memoryTimeoutMs } = require('../server/lib/memory/llmClient');

async function fixture(t, respond) {
    let calls = 0;
    const server = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        calls++;
        await respond(res, JSON.parse(Buffer.concat(chunks).toString('utf8')));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    return { config: { AI_API_URL: `http://127.0.0.1:${server.address().port}/v1/chat/completions`, MODEL_NAME: 'fixture' },
        calls: () => calls };
}
const messages = () => [{ role: 'system', content: 'Companion.' }, { role: 'user', content: 'Hello' }];

test('reserved output prefixes fail while literal token explanations and JSON remain usable', () => {
    for (const text of ['<unused13><unused14>', '<tool_call|>', '[multimodal]',
        '<expression>neutral</expression><unused32>']) {
        assert.throws(() => assertValidModelOutput(text), { code: 'INVALID_MODEL_OUTPUT' });
    }
    for (const text of ['Hello', 'The token `<unused13>` is reserved.', '{"summary":"Hello","facts":[]}',
        '<expression>happy</expression> Hello']) assert.doesNotThrow(() => assertValidModelOutput(text));
    assert.equal(modelOutputState('<un'), 'pending');
});

test('split reserved-token streaming is aborted before exposing or retrying a broken reply', async t => {
    const { config, calls } = await fixture(t, res => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const content of ['<un', 'used13>', '<unused14>']) {
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\n');
        }
        res.end('data: [DONE]\n\n');
    });
    const deltas = [];
    await assert.rejects(runWithTools(messages(), config, delta => deltas.push(delta)), { code: 'INVALID_MODEL_OUTPUT' });
    assert.deepEqual(deltas, []);
    assert.equal(calls(), 1);
});

test('streamed Unicode survives a byte boundary inside the first spoken word', async t => {
    const reply = '<expression>happy</expression> こんにちは！';
    const { config } = await fixture(t, async res => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const body = Buffer.from('data: ' + JSON.stringify({ choices: [{ delta: { content: reply } }] }) + '\n\ndata: [DONE]\n\n');
        const split = body.indexOf(Buffer.from('こ')) + 1;
        res.write(body.subarray(0, split));
        await new Promise(resolve => setImmediate(resolve));
        res.end(body.subarray(split));
    });
    const deltas = [];
    const result = await runWithTools(messages(), config, delta => deltas.push(delta));
    assert.equal(result.message.content, reply);
    assert.equal(deltas.join(''), reply);
});

test('background generation rejects special-token responses without replaying the request', async t => {
    const { config, calls } = await fixture(t, res => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: '<unused32><unused32>' } }] }));
    });
    await assert.rejects(callLlm(messages(), config), { code: 'INVALID_MODEL_OUTPUT' });
    assert.equal(calls(), 1);
});

test('stock JSON requests preserve ordinary background defaults and reject token-limit cutoffs without replay', async t => {
    const requests = [];
    const reply = '{"notify":true,"explanation":"The price changed."}';
    const { config, calls } = await fixture(t, (res, body) => {
        requests.push(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: reply }, finish_reason: requests.length === 3 ? 'length' : 'stop' }] }));
    });
    const options = { responseFormat: { type: 'json_object' }, reasoningEffort: 'none', maxTokens: 600, recordMetrics: false };
    assert.equal(await callLlm(messages(), config, options), reply);
    assert.equal(requests[0].reasoning_effort, 'none');
    assert.deepEqual(requests[0].response_format, { type: 'json_object' });
    assert.equal(requests[0].max_tokens, 600);
    assert.equal(await callLlm(messages(), config, { recordMetrics: false }), reply);
    assert.equal(requests[1].max_tokens, 4096);
    assert.ok(!('reasoning_effort' in requests[1]));
    assert.ok(!('response_format' in requests[1]));
    await assert.rejects(callLlm(messages(), config, options), { code: 'LLM_OUTPUT_TRUNCATED' });
    assert.equal(calls(), 3);
});

test('background extraction deadline is configurable and bounded', t => {
    const previous=process.env.COMPANION_MEMORY_TIMEOUT_MS;
    t.after(()=>{
        if (previous===undefined) delete process.env.COMPANION_MEMORY_TIMEOUT_MS;
        else process.env.COMPANION_MEMORY_TIMEOUT_MS=previous;
    });
    delete process.env.COMPANION_MEMORY_TIMEOUT_MS;
    assert.equal(memoryTimeoutMs(),120000);
    process.env.COMPANION_MEMORY_TIMEOUT_MS='60000';assert.equal(memoryTimeoutMs(),60000);
    process.env.COMPANION_MEMORY_TIMEOUT_MS='9999999';assert.equal(memoryTimeoutMs(),300000);
    process.env.COMPANION_MEMORY_TIMEOUT_MS='bad';assert.equal(memoryTimeoutMs(),120000);
});

test('a stalled background response is canceled at its deadline without retry', async t => {
    const {config,calls}=await fixture(t,res=>{
        res.writeHead(200,{'Content-Type':'application/json'});res.flushHeaders();
    });
    await assert.rejects(callLlm(messages(),config,{timeout:100}),error=>
        ['ERR_CANCELED','ECONNABORTED'].includes(error.code));
    assert.equal(calls(),1);
});
