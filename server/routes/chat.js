// ============================================
// server/routes/chat.js — LM Studio chat completions, per-conversation
// ============================================
const express = require('express');
const fs = require('fs');
const path = require('path');
const { getSettings } = require('../settings.js');
const { runWithTools } = require('../lib/toolCallLoop.js');
const {
    listConversations,
    loadConversation,
    saveConversation,
    createConversation,
    deleteConversation,
    maybeSetTitle,
} = require('../conversations.js');
const {
    buildMemoryContext,
    runBackgroundMemoryJobs,
    finalizeIfSwitchingAway,
} = require('../lib/memory/index.js');

console.log('Loaded conversations module functions:', Object.keys(require('../conversations.js')));

const router = express.Router();

const systemPrompt = fs.readFileSync(path.join(__dirname, '../assets/system-prompt.md'), 'utf8').trim();

// Tracks which conversation was last touched by a /chat request, purely to
// know when to finalize-summarize the one being left. Single-process local
// app, so a module-level variable is fine — this is not meant to survive a
// server restart (a conversation that was mid-way when the server stopped
// just finalizes next time it's actually switched away from, or never,
// which is an acceptable gap for a personal app).
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

router.delete('/conversations/:id', (req, res) => {
    deleteConversation(req.params.id);
    res.json({ deleted: true });
});

router.post('/chat', async (req, res) => {
    const CONFIG = getSettings();
    const { message, conversationId, attachments } = req.body;

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

    let conversation = loadConversation(conversationId);
    if (!conversation) {
        return res.status(404).json({ error: 'Conversation not found.' });
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
        const toolConfig = { ...CONFIG, conversationId, memoryContext };

        const { message: finalMessage, uiEvents } = await runWithTools(
            conversation.messages,
            toolConfig,
            (delta) => sendEvent({ type: 'delta', content: delta }),
        );

        // Everything runWithTools appended this turn — tool calls, tool results,
        // and any injected image-view turns — now lives directly on
        // conversation.messages, since the loop mutates it in place. Scan just the
        // new slice for any generated-document markers, same as before.
        const toolTurns = conversation.messages.slice(messageCountBeforeThisTurn + 1);
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
        maybeSetTitle(conversation);
        saveConversation(conversation);

        // Fire-and-forget background memory jobs — fact extraction + rolling
        // summarization. Kicked off AFTER the reply is sent, never awaited,
        // each swallows its own errors internally (see memory/index.js).
        runBackgroundMemoryJobs({
            conversation,
            userText: message,
            assistantText: reply,
            config: CONFIG,
        });

        sendEvent({
            type: 'done',
            reply,
            conversationId: conversation.id,
            title: conversation.title,
            uiEvents,
            generatedFiles,
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
});

module.exports = router;
