// Read-only synthetic probes. Never sends conversations or stored memories.
const axios = require('axios');
const { StringDecoder } = require('node:string_decoder');
const { performance } = require('node:perf_hooks');
const config = require('../server/settings').getSettings();
const { defaultHttpAgent, getHttpsAgent } = require('../server/lib/httpAgents');

async function memoryCases() {
    const fs = require('node:fs');
    const path = require('node:path');
    const vm = require('node:vm');
    const { execFileSync } = require('node:child_process');
    const root = path.resolve(__dirname, '..');
    const previous = execFileSync('git', ['-c', `safe.directory=${root.replaceAll('\\', '/')}`,
        'show', 'HEAD:server/lib/memory/summaries.js'], { cwd: root, encoding: 'utf8' });
    const current = fs.readFileSync(path.join(root, 'server/lib/memory/summaries.js'), 'utf8');
    async function capture(source) {
        const sentinel = new Error('Captured request');
        let messages;
        const query = () => ({ get: () => undefined });
        const module = { exports: {} };
        vm.runInNewContext(source, { module, performance, require: name => {
            if (name === 'node:crypto') return require(name);
            if (name === './db.js') return { getDb: () => ({ prepare: query }), statement: query,
                memoryEpoch: () => 0, metric: () => {}, touchMemory: () => {} };
            if (name === './facts.js') return { getFactsText: () => '', CATEGORIES: [], upsertFact: () => {} };
            if (name === './llmClient.js') return {};
            throw new Error('Unexpected diagnostic import');
        } });
        try {
            await module.exports.processConversation({ id: 'synthetic', messages: [
                { role: 'system', content: 'You are a companion.' },
                { role: 'user', content: 'I prefer jasmine tea in the evenings.' },
                { role: 'assistant', content: 'Understood.' },
            ] }, {}, { finalize: true, callModel: async value => { messages = value; throw sentinel; } });
        } catch (error) { if (error !== sentinel) throw error; }
        if (!messages) throw new Error('No captured request');
        return messages;
    }
    const oldMessages = await capture(previous), newMessages = await capture(current);
    return [
        ['previous-memory', { messages: oldMessages, stream: false }],
        ['previous-memory-with-cap', { messages: oldMessages, stream: false, max_tokens: 4096 }],
        ['current-memory-without-cap', { messages: newMessages, stream: false }],
        ['current-memory', { messages: newMessages, stream: false, max_tokens: 4096 }],
        ['current-memory-system-only', { messages: [{ role: 'system',
            content: newMessages.map(message => message.content).join('\n') }], stream: false, max_tokens: 4096 }],
    ];
}

async function chatPathCases() {
    const fs = require('node:fs');
    const path = require('node:path');
    const vm = require('node:vm');
    const { execFileSync } = require('node:child_process');
    const root = path.resolve(__dirname, '..');
    const previous = execFileSync('git', ['-c', `safe.directory=${root.replaceAll('\\', '/')}`,
        'show', 'HEAD:server/lib/toolCallLoop.js'], { cwd: root, encoding: 'utf8' });
    const current = fs.readFileSync(path.join(root, 'server/lib/toolCallLoop.js'), 'utf8');
    const definitions = ['music','alarms','weather','web','documents','filesystem','screen','ankiReview']
        .flatMap(name => require(`../server/tools/handlers/${name}`).definitions);
    const messages = [{ role: 'system', content: require('../server/lib/systemPrompt').readSystemPrompt() },
        { role: 'user', content: 'Hello' }];
    async function capture(source, memoryContext = null) {
        const sentinel = new Error('Captured request');
        let body;
        const module = { exports: {} };
        vm.runInNewContext(source, { module, console, require: name => {
            if (name === 'axios') return { post: (_url, value) => {
                body = value;
                return Promise.reject(sentinel);
            } };
            if (name === './toolLoop') return { runToolLoop: (input, cfg, delta, deps) => deps.callModel(input, cfg, delta) };
            if (name === '../tools') return { getToolDefinitions: () => definitions, getToolHandlers: () => ({}) };
            if (name === './attachmentProcessor.js') return { buildExpandedMessages: async input => input };
            if (name === './characters.js') return { readCharacter: () => null };
            if (name === './chatContext.js') return require('../server/lib/chatContext');
            if (name === './modelOutput.js') return require('../server/lib/modelOutput');
            if (name === 'node:string_decoder') return { StringDecoder };
            if (name === './httpAgents.js') return { defaultHttpAgent, getHttpsAgent };
            throw new Error('Unexpected diagnostic import');
        } });
        try {
            await module.exports.runWithTools(structuredClone(messages), { ...config, DEBUG: false, memoryContext });
        } catch (error) { if (error !== sentinel) throw error; }
        if (!body) throw new Error('No captured chat request');
        // Equal generation limits keep both diagnostics bounded; neither source is edited.
        return { ...body, max_tokens: 32 };
    }
    const currentWithoutMemory = await capture(current);
    return [
        ['committed-chat-no-memory', await capture(previous)],
        ['current-chat-no-memory', currentWithoutMemory],
        ['current-chat-synthetic-memory', await capture(current, 'Known user: Alex enjoys jasmine tea.')],
        ['current-chat-without-prompt-cache', { ...currentWithoutMemory, cache_prompt: false }],
    ];
}

async function main() {
    const numberArg = (name, fallback) => Number(process.argv.find(arg => arg.startsWith(`${name}=`))?.slice(name.length + 1)) || fallback;
    const timeout = Math.max(1000, numberArg('--timeout-ms', 15000));
    const maxTokens = numberArg('--max-tokens', 0);
    const endpoint = new URL(config.AI_API_URL);
    console.log(JSON.stringify({ provider: config.llm.provider, host: endpoint.hostname,
        port: endpoint.port, path: endpoint.pathname, selectedModel: config.MODEL_NAME }));
    const options = { timeout, proxy: false, httpAgent: defaultHttpAgent,
        httpsAgent: getHttpsAgent(config.CA_CERT_PATH),
        headers: config.API_KEY ? { Authorization: `Bearer ${config.API_KEY}` } : {} };
    if (process.argv.includes('--server-info')) {
        for (const endpointPath of ['/health', '/props', '/slots']) {
            const url = new URL(config.AI_API_URL);
            url.pathname = endpointPath;
            try {
                const { data } = await axios.get(url.toString(), options);
                if (endpointPath === '/props') {
                    const defaults = data.default_generation_settings || {};
                    const params = defaults.params || defaults;
                    const parameters = {};
                    for (const key of ['n_ctx','n_predict','temperature','top_k','top_p','min_p','repeat_penalty',
                        'samplers','cache_prompt','seed','ignore_eos','chat_format']) parameters[key] = params[key];
                    console.log(JSON.stringify({ endpointPath, keys: Object.keys(data), buildInfo: data.build_info,
                        totalSlots: data.total_slots, templateBytes: Buffer.byteLength(data.chat_template || ''),
                        parameters, logitBias: params.logit_bias, modelPath: data.model_path }));
                } else if (endpointPath === '/slots') {
                    console.log(JSON.stringify({ endpointPath, slots: (Array.isArray(data) ? data : []).map(slot => ({
                        id: slot.id, processing: slot.is_processing, context: slot.n_ctx,
                        decoded: slot.next_token?.n_decoded, predict: slot.params?.n_predict,
                    })) }));
                } else console.log(JSON.stringify({ endpointPath, status: data.status,
                    slotsIdle: data.slots_idle, slotsProcessing: data.slots_processing }));
            } catch (error) { console.log(JSON.stringify({ endpointPath, error: error.code || error.name, status: error.response?.status })); }
        }
        return;
    }
    let availableModels = [];
    try {
        const modelsUrl = new URL(config.AI_API_URL);
        modelsUrl.pathname = modelsUrl.pathname.replace(/\/chat\/completions\/?$/, '/models');
        const response = await axios.get(modelsUrl.toString(), options);
        availableModels = response.data.data?.map(model => model.id) || [];
        console.log(JSON.stringify({ availableModels }));
    } catch (error) { console.log(JSON.stringify({ modelsError: error.code || error.name })); }

    const messages = [{ role: 'user', content: 'Reply with only the word: Hello' }];
    const compareMemory = process.argv.includes('--memory-compare');
    const compareChat = process.argv.includes('--chat-compare');
    const compareChatPath = process.argv.includes('--chat-path-compare');
    const dialogue = [{ role: 'system', content: 'You are a helpful assistant.' }, ...messages];
    const cases = compareChatPath ? await chatPathCases() : compareChat ? [
        ['chat-without-tools', { messages: dialogue, stream: true }],
        ['chat-empty-tools', { messages: dialogue, stream: true, tools: [] }],
        ['chat-with-tools', { messages: dialogue, stream: true,
            tools: require('../server/tools/handlers/weather').definitions }],
    ] : compareMemory ? await memoryCases() : [
        ['previous-request', { stream: false }],
        ['current-request', { stream: false, max_tokens: 4096 }],
        ['streamed-request', { stream: true, max_tokens: 32 }],
        ['deterministic-request', { stream: false, max_tokens: 32, temperature: 0 }],
    ];
    if (!compareMemory && !compareChat && !compareChatPath && availableModels[0]) cases.push(['loaded-model',
        { model: availableModels[0], stream: false, max_tokens: 32, temperature: 0 }]);
    for (const [name, parameters] of cases.filter(([name]) =>
        !process.argv.includes('--loaded-only') || name === 'loaded-model')) {
        if (maxTokens > 0) parameters.max_tokens = maxTokens;
        const started = performance.now();
        try {
            const response = await axios.post(config.AI_API_URL,
                { model: config.MODEL_NAME, messages, ...parameters },
                { ...options, signal: AbortSignal.timeout(timeout),
                    ...(parameters.stream ? { responseType: 'stream' } : {}) });
            let content = '', reasoningBytes = 0, finishReason, returnedModel;
            if (parameters.stream) {
                const decoder = new StringDecoder('utf8');
                let buffer = '';
                try {
                    for await (const chunk of response.data) {
                        buffer += decoder.write(chunk);
                        const lines = buffer.split('\n'); buffer = lines.pop();
                        for (const line of lines) {
                            const trimmed = line.trim();
                            if (!trimmed.startsWith('data:')) continue;
                            const payload = trimmed.slice(5).trim();
                            if (payload === '[DONE]') continue;
                            const data = JSON.parse(payload);
                            content += data.choices?.[0]?.delta?.content || '';
                            reasoningBytes += Buffer.byteLength(data.choices?.[0]?.delta?.reasoning_content || '');
                            finishReason = data.choices?.[0]?.finish_reason || finishReason;
                            returnedModel = data.model || returnedModel;
                        }
                    }
                } finally { response.data.destroy(); }
            } else {
                content = response.data.choices?.[0]?.message?.content || '';
                reasoningBytes = Buffer.byteLength(response.data.choices?.[0]?.message?.reasoning_content || '');
                finishReason = response.data.choices?.[0]?.finish_reason;
                returnedModel = response.data.model;
            }
            let usableReply = /^Hello[.!]?$/i.test(content.trim());
            if (compareChat || compareChatPath) {
                usableReply = Boolean(content.trim()) && require('../server/lib/modelOutput').modelOutputState(content) === 'valid';
            }
            if (compareMemory) {
                try {
                    const parsed = JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/g, '').trim());
                    usableReply = typeof parsed.summary === 'string' && Array.isArray(parsed.facts);
                } catch { usableReply = false; }
            }
            console.log(JSON.stringify({ name, status: response.status, returnedModel, finishReason,
                roles: (parameters.messages || messages).map(message => message.role), maxTokens: parameters.max_tokens || 'server default',
                tools: parameters.tools?.length || 0, requestBytes: Buffer.byteLength(JSON.stringify({ model: config.MODEL_NAME, messages, ...parameters })),
                milliseconds: Math.round(performance.now() - started),
                contentPreview: content.slice(0, 200), reasoningBytes, usableReply }));
            if (!usableReply) process.exitCode = 1;
        } catch (error) {
            console.log(JSON.stringify({ name, error: error.code || error.name, status: error.response?.status }));
            process.exitCode = 1;
        }
    }
}
main().catch(error => { console.error(error.code || error.name); process.exitCode = 1; });
