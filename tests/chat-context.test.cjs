const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { isSimpleSocialText, isSimpleSocialTurn, requestContextStats } = require('../server/lib/chatContext');

test('only standalone social turns omit tools, including punctuation and Finnish greetings', () => {
    for (const text of ['hello', 'Hello! 👋', 'Hi there', 'GOOD MORNING', 'Kiitos!', 'こんにちは']) {
        assert.equal(isSimpleSocialText(text), true, text);
        assert.equal(isSimpleSocialTurn([{ role: 'user', content: text }]), true);
    }
    for (const text of ['Hello, what is the weather?', 'weather', 'Help', 'Say hello to Blender', 'Thanks, save this file']) {
        assert.equal(isSimpleSocialText(text), false, text);
    }
    assert.equal(isSimpleSocialTurn([{ role: 'user', content: 'Hello', attachments: [{}] }]), false);
    assert.equal(isSimpleSocialTurn([{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }]), false);
    assert.equal(isSimpleSocialTurn([{ role: 'user', content: 'Hello' }, { role: 'tool', content: 'Result' }]), false);
});

test('outbound greetings retain companion context without tool schemas; requests and continuations retain tools', async t => {
    const toolModule = require('../server/tools');
    const toolPath = require.resolve('../server/tools');
    const loopPath = require.resolve('../server/lib/toolCallLoop');
    const definitions = [{ type: 'function', function: { name: 'get_weather', description: 'x'.repeat(30000),
        parameters: { type: 'object', properties: {}, additionalProperties: false } } }];
    require.cache[toolPath].exports = { ...toolModule, getToolDefinitions: () => definitions, getToolHandlers: () => ({}) };
    delete require.cache[loopPath];
    const { runWithTools } = require(loopPath);
    t.after(() => { require.cache[toolPath].exports = toolModule; delete require.cache[loopPath]; });
    const bodies = [];
    const server = http.createServer(async (req, res) => {
        let text = '';
        for await (const chunk of req) text += chunk;
        bodies.push(JSON.parse(text));
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: '<expression>happy</expression> Hello!' } }] }) + '\n\ndata: [DONE]\n\n');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const config = { AI_API_URL: `http://127.0.0.1:${server.address().port}/v1/chat/completions`, MODEL_NAME: 'fixture',
        memoryContext: 'Known user: Alex' };
    const messages = [{ role: 'system', content: 'You are a warm companion. Start with an expression tag.' },
        { role: 'user', content: 'Hello!' }];
    const original = structuredClone(messages);
    const reply = await runWithTools(messages, config);
    assert.match(reply.message.content, /Hello/);
    assert.equal(bodies[0].tools, undefined);
    assert.match(bodies[0].messages[0].content, /warm companion/);
    assert.match(bodies[0].messages[0].content, /expression tag/);
    assert.match(bodies[0].messages[0].content, /Known user: Alex/);
    assert.deepEqual(messages, original);
    await runWithTools([...original.slice(0, 1), { role: 'user', content: 'Hello, what is the weather?' }], config);
    assert.deepEqual(bodies[1].tools, definitions);
    await runWithTools([...original, { role: 'assistant', content: null, tool_calls: [
        { id: 'weather-1', type: 'function', function: { name: 'get_weather', arguments: '{}' } },
    ] }, { role: 'tool', tool_call_id: 'weather-1', content: 'Sunny' }], config);
    assert.deepEqual(bodies[2].tools, definitions);
    const greeting = requestContextStats(bodies[0]), normal = requestContextStats(bodies[1]);
    assert.equal(greeting.toolBytes, 0);
    assert.ok(normal.toolBytes > 30000);
    assert.ok(normal.requestBytes - greeting.requestBytes > 30000);
});
