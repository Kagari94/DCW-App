// ============================================
// server/lib/visionGatekeeper.js — one-shot vision-model call with tool-
// calling escalation, for the live-camera background monitor
// ============================================
const axios = require('axios');
const { defaultHttpAgent, getHttpsAgent } = require('./httpAgents.js');

function isConnectionReset(err) {
    return err.code === 'ECONNRESET' || err.message === 'socket hang up';
}

// Deliberately conservative — a false alarm is worse than a missed one for
// a background monitor the user didn't explicitly ask about right now.
const SYSTEM_PROMPT =
    'You are a background visual monitor watching a live camera feed, one frame at a time, ' +
    'roughly every few seconds. Most frames show nothing worth mentioning — an empty or ' +
    'unchanged scene, routine activity, something already noted. Stay silent (do not call the ' +
    'tool) for anything routine. Only call escalate() when something in THIS frame is genuinely ' +
    'worth interrupting the user for right now: a person entering/leaving, something visibly ' +
    'wrong, unsafe, or unexpected, or something the user would plausibly want to know about ' +
    'immediately. Be conservative — when in doubt, stay silent.';

// imageBase64: raw base64 (no data: prefix — added here). config mirrors
// the same shape toolCallLoop.js/llmClient.js use: AI_API_URL, MODEL_NAME,
// API_KEY, CA_CERT_PATH. Returns the escalation description string, or
// null if the model chose not to escalate this frame.
async function analyzeFrame(imageBase64, config) {
    const requestConfig = {
        headers: {
            'Content-Type': 'application/json',
            ...(config.API_KEY && { Authorization: `Bearer ${config.API_KEY}` }),
        },
        // Generous — a CPU-bound vision model can genuinely take a while,
        // and a false "failed" from too-short a timeout is worse than
        // just waiting; the client's own capture loop already re-paces
        // itself around however long each call actually takes.
        timeout: 20000,
        httpAgent: defaultHttpAgent,
        httpsAgent: getHttpsAgent(config.CA_CERT_PATH),
        proxy: false, // else axios silently honors HTTP_PROXY/HTTPS_PROXY env vars
    };

    const body = {
        model: config.MODEL_NAME,
        stream: false,
        messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            {
                role: 'user',
                content: [
                    { type: 'text', text: 'Current camera frame:' },
                    { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } },
                ],
            },
        ],
        tools: [{
            type: 'function',
            function: {
                name: 'escalate',
                description: 'Call this ONLY when something in the frame is genuinely worth telling the user about right now.',
                parameters: {
                    type: 'object',
                    properties: {
                        description: {
                            type: 'string',
                            description: 'One or two plain-language sentences describing what is notable, to relay to the user.',
                        },
                    },
                    required: ['description'],
                },
            },
        }],
        tool_choice: 'auto',
    };

    async function attempt() {
        const response = await axios.post(config.AI_API_URL, body, requestConfig);
        const message = response.data.choices?.[0]?.message;
        const call = message?.tool_calls?.find(tc => tc.function?.name === 'escalate');
        if (!call) return null;

        try {
            const args = JSON.parse(call.function.arguments || '{}');
            return typeof args.description === 'string' ? args.description : null;
        } catch {
            return null;
        }
    }

    try {
        return await attempt();
    } catch (err) {
        if (!isConnectionReset(err)) throw err;
        return await attempt(); // one retry — same reasoning as llmClient.js/toolCallLoop.js, see gotcha 19
    }
}

module.exports = { analyzeFrame };