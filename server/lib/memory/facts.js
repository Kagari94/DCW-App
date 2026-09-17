// ============================================
// server/lib/memory/facts.js — structured fact storage (auto-extracted)
// ============================================
const { getDb } = require('./db.js');
const { callLlm } = require('./llmClient.js');

function upsertFact(category, key, value, sourceConversationId) {
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(`
        INSERT INTO facts (category, key, value, source_conversation_id, created_at, updated_at)
        VALUES (@category, @key, @value, @sourceConversationId, @now, @now)
        ON CONFLICT(category, key) DO UPDATE SET
            value = excluded.value,
            source_conversation_id = excluded.source_conversation_id,
            updated_at = excluded.updated_at
    `).run({ category, key, value, sourceConversationId, now });
}

function getAllFacts() {
    const db = getDb();
    return db.prepare('SELECT category, key, value FROM facts ORDER BY category, key').all();
}

// Rendered as a flat, human-readable block for system-prompt injection —
// deliberately plain text (not JSON) so it's easy to eyeball what the model
// is actually being told, and easy to hand-edit the DB later if needed.
function getFactsText() {
    const facts = getAllFacts();
    if (facts.length === 0) return '';
    const lines = facts.map(f => `- [${f.category}] ${f.key}: ${f.value}`);
    return `Known facts about the user and their projects:\n${lines.join('\n')}`;
}

const FACT_EXTRACTION_PROMPT = `You extract durable, reusable facts from a chat exchange — the kind worth remembering for future conversations (identity, preferences, project details, decisions). Ignore small talk, one-off questions, and anything not worth persisting long-term.

Respond ONLY with a JSON array, nothing else, no markdown fences. Each item: {"category": string, "key": string, "value": string}. Category is a short label like "identity", "preference", "project". Key is a short stable identifier (e.g. "name", "editor", "current_project") — reuse the same key when updating a fact rather than inventing a new one. Value is the fact itself, stated plainly. If there is nothing worth storing, respond with [].`;

// Fire-and-forget from chat.js — never awaited on the response path, and
// swallows its own errors so a bad extraction never surfaces to the user.
// Reuses whichever provider/model is currently active in settings, via
// llmClient.js (no keep-alive + one retry on a dropped connection — see
// that file for why these background calls need it).
async function extractFactsFromExchange(userText, assistantText, conversationId, config) {
    try {
        const raw = await callLlm([
            { role: 'system', content: FACT_EXTRACTION_PROMPT },
            { role: 'user', content: `User: ${userText}\n\nAssistant: ${assistantText}` },
        ], config);

        if (!raw) return;

        const cleaned = raw.replace(/^```json\s*|```$/g, '').trim();
        const facts = JSON.parse(cleaned);
        if (!Array.isArray(facts)) return;

        for (const f of facts) {
            if (f?.category && f?.key && f?.value) {
                upsertFact(String(f.category), String(f.key), String(f.value), conversationId);
            }
        }
    } catch (err) {
        console.error('⚠️ Fact extraction failed (non-fatal):', err.message);
    }
}

module.exports = { getAllFacts, getFactsText, upsertFact, extractFactsFromExchange };