// ============================================
// server/lib/memory/llmClient.js — shared LLM caller for background memory jobs
// ============================================
const axios = require('axios');
const { defaultHttpAgent, getHttpsAgent } = require('../httpAgents.js');
const { metric } = require('./db.js');
const { requestContextStats } = require('../chatContext.js');
const { assertValidModelOutput } = require('../modelOutput.js');

// Connection was dropped rather than answered — the server was reachable
// and accepted the socket, then closed it. Worth one retry. Deliberately
// NOT retried: HTTP error statuses (a 400 would just fail identically
// twice) or timeouts (already waited the full timeout once).
function isConnectionReset(err) {
    return err.code === 'ECONNRESET' || err.message === 'socket hang up';
}

function memoryTimeoutMs() {
    const requested = Number(process.env.COMPANION_MEMORY_TIMEOUT_MS);
    return Number.isFinite(requested) && requested > 0
        ? Math.max(1000, Math.min(300000, Math.floor(requested))) : 120000;
}

async function callLlm(messages, config, { timeout = memoryTimeoutMs(), signal, maxTokens = 4096,
    recordMetrics = true, responseFormat, reasoningEffort } = {}) {
    const requestConfig = {
        headers: {
            'Content-Type': 'application/json',
            ...(config.API_KEY && { Authorization: `Bearer ${config.API_KEY}` }),
        },
        timeout,
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
        httpAgent: defaultHttpAgent,
        httpsAgent: getHttpsAgent(config.CA_CERT_PATH),
        proxy: false, // else axios silently honors HTTP_PROXY/HTTPS_PROXY env
                      // vars and routes this somewhere unintended — same
                      // reasoning as tools/handlers/web.js
    };

    const body = {
        model: config.MODEL_NAME,
        messages,
        stream: false,
        max_tokens: maxTokens,
    };
    if (responseFormat) body.response_format = responseFormat;
    if (reasoningEffort !== undefined) body.reasoning_effort = reasoningEffort;
    if (config.DEBUG) console.log(recordMetrics ? 'Background memory request context:' : 'Background analysis request context:', requestContextStats(body));

    async function send() {
        if (recordMetrics) metric('llm_http_requests');
        const response = await axios.post(config.AI_API_URL, body, requestConfig);
        if (recordMetrics && response.data.usage) {
            metric('input_tokens_reported', response.data.usage.prompt_tokens || 0);
            metric('output_tokens_reported', response.data.usage.completion_tokens || 0);
        }
        const choice = response.data.choices?.[0];
        if (responseFormat && choice?.finish_reason === 'length') {
            throw Object.assign(new Error('Structured model output exceeded its token limit.'), { code: 'LLM_OUTPUT_TRUNCATED' });
        }
        const content = choice?.message?.content?.trim() || '';
        assertValidModelOutput(content);
        return content;
    }

    try {
        return await send();
    } catch (err) {
        if (!isConnectionReset(err)) throw err;

        if (config.DEBUG) {
            console.log('🔁 Background LLM call dropped by server, retrying once...');
        }
        return send();
    }
}

module.exports = { callLlm, memoryTimeoutMs };
