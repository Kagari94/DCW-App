// ============================================
// server/lib/heartbeat/checks/ankiDueCards.js — Anki due-card heartbeat check
// ============================================
const { unwrapMcpResult } = require('../../mcpResult.js');

module.exports = {
    id: 'anki-due-cards',
    eventType: 'due_cards',
    intervalMs: 20 * 60 * 1000, // every 20 min — inside the requested 15-30 min window
    cooldownMs: 60 * 60 * 1000, // don't re-nudge about an unchanged backlog more than hourly

    async run({ getToolHandlers }) {
        const handler = getToolHandlers()['get_due_cards'];
        if (!handler) return null; // Anki MCP server not connected — nothing to check

        const raw = await handler({});
        const parsed = unwrapMcpResult(raw);
        if (!parsed || typeof parsed.dueCount !== 'number' || parsed.dueCount === 0) return null;

        return { dueCount: parsed.dueCount };
    },
};