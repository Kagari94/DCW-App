// ============================================
// server/routes/anki.js — REST API for the Anki review window
// ============================================
// Deliberately NOT routed through the normal /chat tool-loop — a review
// session fires one request per card, which would be slow (a full LLM
// round-trip per card) and would spam the conversation history with
// review turns. Instead this calls the same Anki MCP tools directly,
// server-side, the same way the heartbeat check does — the review window
// talks to these routes, not to /chat, for the actual grading loop.
// Voice-mode "discuss this card with the AI" is a SEPARATE, deliberate
// chat turn the client triggers itself (see AnkiWindow.jsx) — that one
// intentionally does go through /chat, since discussion is exactly what
// the model is for.
const express = require('express');
const { unwrapMcpResult } = require('../lib/mcpResult.js');

function makeRouter({ getToolHandlers }) {
    const router = express.Router();

    function handlerFor(name) {
        const handler = getToolHandlers()[name];
        if (!handler) throw Object.assign(new Error(`Anki tool "${name}" is not available — is the Anki MCP server connected?`), { status: 503 });
        return handler;
    }

    router.get('/anki/due-cards', async (req, res) => {
        try {
            const handler = handlerFor('get_due_cards');
            const raw = await handler({ deck: req.query.deck || undefined });
            const parsed = unwrapMcpResult(raw);
            if (!parsed) return res.status(502).json({ error: 'Unexpected response from Anki server.' });
            res.json(parsed); // { dueCount, cards }
        } catch (err) {
            res.status(err.status || 500).json({ error: err.message });
        }
    });

    router.post('/anki/grade', async (req, res) => {
        const { cardId, answer } = req.body || {};
        if (!cardId || typeof answer !== 'string') {
            return res.status(400).json({ error: 'cardId and answer are required.' });
        }
        try {
            const handler = handlerFor('grade_card');
            const raw = await handler({ cardId, answer });
            const parsed = unwrapMcpResult(raw);
            if (!parsed) return res.status(502).json({ error: 'Unexpected response from Anki server.' });
            if (parsed.error) return res.status(404).json({ error: parsed.error });
            res.json(parsed); // { correct, correctAnswer, card }
        } catch (err) {
            res.status(err.status || 500).json({ error: err.message });
        }
    });

    router.get('/anki/card/:id', async (req, res) => {
        try {
            const handler = handlerFor('get_card');
            const raw = await handler({ cardId: req.params.id });
            const parsed = unwrapMcpResult(raw);
            if (!parsed) return res.status(502).json({ error: 'Unexpected response from Anki server.' });
            if (parsed.error) return res.status(404).json({ error: parsed.error });
            res.json(parsed);
        } catch (err) {
            res.status(err.status || 500).json({ error: err.message });
        }
    });

    return router;
}

module.exports = { makeRouter };