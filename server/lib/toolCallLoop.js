// ============================================
// server/lib/toolCallLoop.js — model-agnostic tool-calling round-trip loop
// ============================================
const axios = require('axios');
const { getToolDefinitions, getToolHandlers } = require('../tools');
const { buildExpandedMessages } = require('./attachmentProcessor.js');
const { defaultHttpAgent, getHttpsAgent } = require('./httpAgents.js');

function isConnectionReset(err) {
    return err.code === 'ECONNRESET' || err.message === 'socket hang up';
}

// Injected fresh on every model call so the model always knows today's real
// date — a static system prompt read once at server startup would otherwise
// leave it permanently anchored to its training cutoff, with no way to know
// time has passed at all. Kept out of the persisted conversation (never
// pushed onto `messages` itself) so it can't go stale in saved history.
function withCurrentDateTime(messages) {
    const now = new Date();
    const formatted = now.toLocaleString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        timeZoneName: 'short',
    });

    const dateNote =
        `Current date and time: ${formatted}. Use this for any question involving ` +
        `today's date, the current time, or relative time references ("this year", ` +
        `"recently", "currently", etc). Do not rely on your training data for what ` +
        `the current date is — it is outdated. For anything requiring up-to-date facts ` +
        `(news, prices, current events), use web_search rather than assuming from memory.`;

    if (!messages.length || messages[0].role !== 'system') {
        throw new Error('Conversation must begin with a system message.');
    }

    return [
        {
            ...messages[0],
            content: `${messages[0].content}\n\n${dateNote}`,
        },
        ...messages.slice(1),
    ];
}

function withMemoryContext(messages, memoryContextText) {
    if (!memoryContextText) return messages;

    if (!messages.length || messages[0].role !== 'system') {
        throw new Error('Conversation must begin with a system message.');
    }

    return [
        {
            ...messages[0],
            content: `${messages[0].content}\n\n${memoryContextText}`,
        },
        ...messages.slice(1),
    ];
}

const MAX_ITERATIONS = 6; // raised from 4 — image-viewing workflows (list -> view -> rename) add extra hops

// One streaming attempt. Resolves with the assembled assistant message.
// `onFirstDelta` fires the moment any content reaches the client — the
// caller uses it to know whether a retry is still safe (see callModel).
function streamOnce(requestBody, config, onContentDelta, onFirstDelta) {
    return axios.post(config.AI_API_URL, requestBody, {
        headers: {
            'Content-Type': 'application/json',
            ...(config.API_KEY && { Authorization: `Bearer ${config.API_KEY}` }),
        },
        responseType: 'stream',
        httpAgent: defaultHttpAgent,
        // CA_CERT_PATH lets a specific provider (e.g. a LAN endpoint behind
        // a self-signed reverse proxy) pin trust to one cert, without
        // weakening verification for every other HTTPS call. See
        // settings.js's deriveModelConfig and httpAgents.js.
        httpsAgent: getHttpsAgent(config.CA_CERT_PATH),
        proxy: false, // else axios silently honors HTTP_PROXY/HTTPS_PROXY env
                      // vars — same reasoning as tools/handlers/web.js
    }).then(response => new Promise((resolve, reject) => {
        let buffer = '';
        let content = '';
        const toolCallAccumulator = {};

        response.data.on('data', (chunk) => {
            buffer += chunk.toString('utf8');
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.startsWith('data:')) continue;
                const payload = trimmed.slice(5).trim();
                if (payload === '[DONE]') continue;

                let parsed;
                try {
                    parsed = JSON.parse(payload);
                } catch {
                    continue;
                }

                const choice = parsed.choices?.[0];
                if (!choice) continue;
                const delta = choice.delta || {};

                if (delta.content) {
                    if (content === '') onFirstDelta();
                    content += delta.content;
                    if (onContentDelta) onContentDelta(delta.content);
                }

                if (delta.tool_calls) {
                    for (const tc of delta.tool_calls) {
                        const idx = tc.index ?? 0;
                        if (!toolCallAccumulator[idx]) {
                            toolCallAccumulator[idx] = {
                                id: tc.id,
                                type: tc.type || 'function',
                                function: { name: '', arguments: '' },
                            };
                        }
                        if (tc.id) toolCallAccumulator[idx].id = tc.id;
                        if (tc.function?.name) toolCallAccumulator[idx].function.name += tc.function.name;
                        if (tc.function?.arguments) toolCallAccumulator[idx].function.arguments += tc.function.arguments;
                    }
                }
            }
        });

        response.data.on('end', () => {
            const toolCalls = Object.keys(toolCallAccumulator).length > 0
                ? Object.values(toolCallAccumulator)
                : undefined;
            resolve({ role: 'assistant', content: content || null, tool_calls: toolCalls });
        });

        response.data.on('error', reject);
    }));
}

async function callModel(messages, config, onContentDelta) {
    const toolDefinitions = getToolDefinitions();

    // Expanded fresh on every call, not once upfront — this is what lets a
    // tool (like view_image) inject a new lean attachment mid-loop and have
    // it actually reach the model on the very next call, while what gets
    // persisted (`messages`, mutated below) stays lean path-only metadata.
    const withDate = withCurrentDateTime(await buildExpandedMessages(messages));
    const expandedMessages = withMemoryContext(withDate, config.memoryContext);

    if (config.DEBUG) {
        const last = expandedMessages[expandedMessages.length - 1];
        if (Array.isArray(last?.content)) {
            console.log('📤 Multimodal content being sent to model:', last.content.map(part =>
                part.type === 'image_url'
                    ? `image_url (${part.image_url.url.length} chars)`
                    : `text (${part.text.length} chars)`
            ));
        }
    }

    const requestBody = {
        model: config.MODEL_NAME,
        messages: expandedMessages,
        tools: toolDefinitions.length > 0 ? toolDefinitions : undefined,
        stream: true,
    };

    // A dropped connection is only safely retryable while NOTHING has been
    // streamed to the client yet — once deltas are out, replaying the call
    // would duplicate text mid-reply on screen. `emitted` tracks that.
    let emitted = false;
    const markEmitted = () => { emitted = true; };

    try {
        return await streamOnce(requestBody, config, onContentDelta, markEmitted);
    } catch (err) {
        if (!isConnectionReset(err) || emitted) throw err;

        if (config.DEBUG) {
            console.log('🔁 Model stream dropped before any output, retrying once...');
        }
        return await streamOnce(requestBody, config, onContentDelta, markEmitted);
    }
}

// `messages` is now expected to be the LEAN, persisted-form array
// (conversation.messages itself, mutated directly) — not a pre-expanded
// copy. Expansion happens fresh inside callModel on every iteration.
//
// Return shape is one of two things now:
//   { message, uiEvents }                          — normal completion
//   { needsScreenFrame: { toolCallId }, uiEvents }  — paused, waiting on
//                                                      the client (see below)
async function runWithTools(messages, config, onContentDelta) {
    const toolHandlers = getToolHandlers();
    const uiEvents = [];

    for (let i = 0; i < MAX_ITERATIONS; i++) {
        const message = await callModel(messages, config, onContentDelta);
        const toolCalls = message.tool_calls;

        if (!toolCalls || toolCalls.length === 0) {
            return { message, uiEvents };
        }

        messages.push(message);

        for (const call of toolCalls) {
            const handler = toolHandlers[call.function.name];
            let result;

            if (!handler) {
                result = { error: `Unknown tool: ${call.function.name}` };
            } else {
                try {
                    const args = JSON.parse(call.function.arguments || '{}');
                    result = await handler(args, config);
                } catch (err) {
                    console.error(`Tool "${call.function.name}" failed:`, err);
                    result = { error: err.message };
                }
            }

            if (result && result.ui) uiEvents.push(result.ui);

            if (result && result.__viewImage) {
                const img = result.__viewImage;
                messages.push({
                    role: 'tool',
                    tool_call_id: call.id,
                    content: JSON.stringify({ ok: true, note: `Image "${img.filename}" loaded — see below.` }),
                });
                messages.push({
                    role: 'user',
                    content: `[Viewing image: ${img.filename}]`,
                    attachments: [{
                        path: img.absolutePath,
                        filename: img.filename,
                        storedFilename: img.filename,
                        size: img.size,
                    }],
                });
                continue;
            }

            if (result && result.__needScreenFrame) {
                return { needsScreenFrame: { toolCallId: call.id }, uiEvents };
            }

            messages.push({
                role: 'tool',
                tool_call_id: call.id,
                content: JSON.stringify(result),
            });
        }
    }

    throw new Error(`Tool call loop exceeded ${MAX_ITERATIONS} iterations without a final reply`);
}

module.exports = { runWithTools };