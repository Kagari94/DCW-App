// ============================================
// server/routes/chat.js — LM Studio chat completions, per-conversation
// ============================================
const express = require('express');
const { validateConversationId } = require('../conversations');
const { withConversationLock } = require('../lib/conversationLock');
const { pendingToolCalls } = require('../lib/toolLoop');
const { readSystemPrompt } = require('../lib/systemPrompt');

function makeRouter({
    store = require('../conversations'),
    getSettings = require('../settings').getSettings,
    runWithTools = require('../lib/toolCallLoop').runWithTools,
    memory = require('../lib/memory'),
    systemPrompt = readSystemPrompt(),
} = {}) {
    const { listConversations, loadConversation, saveConversation, createConversation,
        deleteConversation, maybeSetTitle } = { ...require('../conversations'), ...store };
    const { buildMemoryContext, runBackgroundMemoryJobs, finalizeIfSwitchingAway } = memory;

    function serialized(handler) {
        return async (req, res) => {
            const id = validateConversationId(req.params.id ?? req.body?.conversationId);
            await withConversationLock(id, () => handler(req, res));
        };
    }

    const router = express.Router();


    // Finalize the previous conversation when the user switches away.
    let lastActiveConversationId = null;

    router.get('/conversations', (req, res) => {
        res.json({ conversations: listConversations() });
    });

    router.post('/conversations', (req, res) => {
        const conversation = createConversation(systemPrompt);
        res.json(conversation);
    });

    router.get('/conversations/:id', (req, res) => {
        const conversation = loadConversation(req.params.id);
        if (!conversation) return res.status(404).json({ error: 'Conversation not found.' });
        res.json(conversation);
    });

    router.delete('/conversations/:id', serialized((req, res) => {
        deleteConversation(req.params.id);
        memory.deleteConversationMemory?.(req.params.id);
        res.json({ deleted: true });
    }));

    // Both entrypoints complete a reply or persist a pending screen capture.
    async function runTurnAndRespond({ conversation, toolConfig, sendEvent, CONFIG, messageCountBeforeThisTurn, userTextForMemoryJobs }) {
        const { message: finalMessage, uiEvents, needsScreenFrame } = await runWithTools(
            conversation.messages,
            toolConfig,
            (delta) => sendEvent({ type: 'delta', content: delta }),
        );

        if (needsScreenFrame) {
            // Nothing final happened — just persist the pending tool_calls
            // message that's now on conversation.messages, and tell the
            // client to go capture a frame and continue. No 'done' event,
            // no background memory jobs — those only make sense once there's
            // an actual reply.
            conversation.pendingTurn = {
                memoryContext: toolConfig.memoryContext, userText: userTextForMemoryJobs,
                toolCallId: needsScreenFrame.toolCallId,
                uiEvents: [...(conversation.pendingTurn?.uiEvents || []), ...(uiEvents || [])],
                messageStart: conversation.pendingTurn?.messageStart ?? messageCountBeforeThisTurn,
            };
            saveConversation(conversation);
            sendEvent({ type: 'need_screen_frame', toolCallId: needsScreenFrame.toolCallId, conversationId: conversation.id });
            return;
        }

        // Everything runWithTools appended this turn — tool calls, tool results,
        // and any injected image-view/screen-frame turns — now lives directly on
        // conversation.messages, since the loop mutates it in place. Scan just the
        // new slice for any generated-document markers, same as before.
        const toolTurns = conversation.messages.slice(conversation.pendingTurn?.messageStart ?? messageCountBeforeThisTurn);
        const generatedFiles = [];
        for (const turn of toolTurns) {
            if (turn.role !== 'tool') continue;
            try {
                const parsed = JSON.parse(turn.content);
                if (parsed?.generatedFile) generatedFiles.push(parsed.generatedFile);
            } catch { /* not JSON or no generatedFile — ignore */ }
        }

        const reply = finalMessage.content;
        if (!reply) throw new Error('No content in AI response.');

        conversation.messages.push({
            role: 'assistant',
            content: reply,
            ...(generatedFiles.length ? { generatedFiles } : {}),
        });
        const allUiEvents = [...(conversation.pendingTurn?.uiEvents || []), ...(uiEvents || [])];
        delete conversation.pendingTurn;
        maybeSetTitle(conversation);
        saveConversation(conversation);

        // A resumed turn retains the original user text for memory extraction.
        if (userTextForMemoryJobs) {
            runBackgroundMemoryJobs({
                conversation,
                userText: userTextForMemoryJobs,
                assistantText: reply,
                config: CONFIG,
            });
        }

        sendEvent({
            type: 'done',
            reply,
            conversationId: conversation.id,
            title: conversation.title,
            uiEvents: allUiEvents,
            generatedFiles,
        });
    }

    router.post('/chat', serialized(async (req, res) => {
        const CONFIG = getSettings();
        const { message, conversationId, attachments, screenSessionActive } = req.body;

        if (!message || typeof message !== 'string') {
            return res.status(400).json({ error: 'Message is required.' });
        }
        if (!conversationId) {
            return res.status(400).json({ error: 'conversationId is required.' });
        }
        if (message.length > CONFIG.MAX_REQUEST_LENGTH) {
            return res.status(400).json({ error: `Request too long. Max ${CONFIG.MAX_REQUEST_LENGTH} characters.` });
        }
        if (attachments !== undefined && !Array.isArray(attachments)) {
            return res.status(400).json({ error: 'attachments must be an array.' });
        }

        const conversation = loadConversation(conversationId);
        if (!conversation) {
            return res.status(404).json({ error: 'Conversation not found.' });
        }

        if (conversation.pendingTurn) {
            return res.status(409).json({ error: 'Finish the pending screen capture before sending another message.' });
        }

        // If the previous request was for a different conversation, that one is
        // being left now — finalize its summary in the background so it becomes
        // searchable memory. Fire-and-forget: never blocks this request.
        if (lastActiveConversationId && lastActiveConversationId !== conversationId) {
            const previousConversation = loadConversation(lastActiveConversationId);
            finalizeIfSwitchingAway(previousConversation, CONFIG);
        }
        lastActiveConversationId = conversationId;

        // Everything past this point commits to a streaming response — once
        // these headers go out, HTTP status codes can no longer change, so any
        // failure below (unreachable LM Studio, bad model name, etc.) has to be
        // reported as an inline {type:'error'} event instead of a 4xx/5xx.
        res.setHeader('Content-Type', 'application/x-ndjson');
        res.setHeader('Cache-Control', 'no-cache');
        if (res.flushHeaders) res.flushHeaders();

        function sendEvent(event) {
            res.write(JSON.stringify(event) + '\n');
        }

        if (CONFIG.DEBUG) {
            console.log('🔄 Calling AI API:', CONFIG.AI_API_URL);
            console.log('📦 Model:', CONFIG.MODEL_NAME);
            console.log('💬 User:', message.substring(0, 30));
            if (attachments?.length) console.log('📎 Attachments:', attachments.map(a => a.filename));
        }

        const userMessage = { role: 'user', content: message };
        if (attachments && attachments.length > 0) {
            userMessage.attachments = attachments;
        }
        conversation.messages.push(userMessage);
        const messageCountBeforeThisTurn = conversation.messages.length - 1;

        try {
            // Built once per turn (facts always, retrieved chunks only if the
            // heuristic in retrieval.js thinks they're relevant) and threaded
            // through toolConfig so toolCallLoop.js can inject it fresh on every
            // model call without recomputing it per tool-loop iteration.
            const memoryContext = await buildMemoryContext(message, conversationId);
            // screenSessionActive comes from the client on every request — it's
            // per-session UI state (is getDisplayMedia currently authorized in
            // THIS browser tab), not something the server can know or persist
            // on its own. tools/handlers/screen.js reads this to decide whether
            // view_screen can actually be fulfilled.
            const toolConfig = { ...CONFIG, conversationId, memoryContext, screenSessionActive: Boolean(screenSessionActive) };

            await runTurnAndRespond({
                conversation,
                toolConfig,
                sendEvent,
                CONFIG,
                messageCountBeforeThisTurn,
                userTextForMemoryJobs: message,
            });
            res.end();

        } catch (error) {
            if (CONFIG.DEBUG) {
                console.error('❌ AI API Error:', error.message);
                console.error('Response:', error.response?.data);
            }

            conversation.messages.length = messageCountBeforeThisTurn;
            saveConversation(conversation);

            let errorMsg = `⚠️ AI Error: ${error.message}`;
            if (error.code === 'ECONNREFUSED') errorMsg = '⚠️ AI Server not reachable. Make sure LM Studio is running!';
            else if (error.response?.status === 400) errorMsg = `⚠️ ${error.response.data?.error?.message || 'Invalid request format'}`;
            else if (error.response?.status === 401) errorMsg = '⚠️ Authentication failed. Check API key in settings.';
            else if (error.response?.status === 404) errorMsg = '⚠️ Model not found. Check model name in settings.';
            else if (error.code === 'ECONNABORTED') errorMsg = '⚠️ Request timed out. AI server might be busy.';

            sendEvent({ type: 'error', error: errorMsg });
            res.end();
        }
    }));

    // Resumes a conversation that paused on a `need_screen_frame` event. The
    // client has already uploaded the captured frame through the normal
    // attachments endpoint (same as any manual file attach) by the time this
    // is called — `attachment` here is that upload's returned metadata
    // ({filename, storedFilename, size}), not raw image bytes.
    router.post('/chat/continue', serialized(async (req, res) => {
        const CONFIG = getSettings();
        const { conversationId, toolCallId, attachment, screenSessionActive } = req.body;

        if (!conversationId) return res.status(400).json({ error: 'conversationId is required.' });
        if (!toolCallId) return res.status(400).json({ error: 'toolCallId is required.' });
        if (!attachment?.storedFilename) return res.status(400).json({ error: 'attachment is required.' });

        const conversation = loadConversation(conversationId);
        if (!conversation) return res.status(404).json({ error: 'Conversation not found.' });

        const pendingCall = pendingToolCalls(conversation.messages).find(call => call.id === toolCallId);
        if (!pendingCall) {
            return res.status(409).json({ error: 'No matching pending tool call on this conversation — it may have already been resolved.' });
        }

        res.setHeader('Content-Type', 'application/x-ndjson');
        res.setHeader('Cache-Control', 'no-cache');
        if (res.flushHeaders) res.flushHeaders();

        function sendEvent(event) {
            res.write(JSON.stringify(event) + '\n');
        }

        const messageCountBeforeThisTurn = conversation.messages.length;
        const pendingTurn = conversation.pendingTurn;

        // Same shape as the __viewImage injection in toolCallLoop.js — a
        // lightweight tool ack (every tool_call_id needs one) followed by a
        // lean user-role turn carrying the attachment metadata. Expansion into
        // real image bytes happens the normal way, via buildExpandedMessages,
        // the same path any user-uploaded attachment already goes through —
        // no special-casing needed there since this went through the same
        // upload endpoint as a manual attach.
        conversation.messages.push({
            role: 'tool',
            tool_call_id: toolCallId,
            content: JSON.stringify({ ok: true, note: 'Screen frame captured — see below.' }),
        });
        conversation.messages.push({
            role: 'user',
            content: '[Screen frame captured]',
            attachments: [attachment],
        });

        try {
            const memoryContext = pendingTurn ? pendingTurn.memoryContext : await buildMemoryContext('', conversationId);
            const toolConfig = { ...CONFIG, conversationId, memoryContext, screenSessionActive: Boolean(screenSessionActive) };

            await runTurnAndRespond({
                conversation,
                toolConfig,
                sendEvent,
                CONFIG,
                messageCountBeforeThisTurn,
                userTextForMemoryJobs: pendingTurn?.userText,
            });
            res.end();

        } catch (error) {
            if (CONFIG.DEBUG) {
                console.error('❌ AI API Error (continue):', error.message);
                console.error('Response:', error.response?.data);
            }

            conversation.messages.length = messageCountBeforeThisTurn;
            conversation.pendingTurn = pendingTurn;
            saveConversation(conversation);

            sendEvent({ type: 'error', error: `⚠️ AI Error: ${error.message}` });
            res.end();
        }
    }));

    router.use((error, req, res, next) => {
        if (res.headersSent) return next(error);
        res.status(error.status || 500).json({ error: error.message });
    });
    return router;
}

module.exports = { makeRouter };
