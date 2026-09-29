const { getDb } = require('./db.js');
const { upsertFact, getFactsText } = require('./facts.js');
const { callLlm } = require('./llmClient.js');

const BATCH_MESSAGES = 12;
const MAX_CHUNK_CHARS = 12000;

function getSummaryRow(conversationId) {
    return getDb().prepare('SELECT * FROM conversation_summaries WHERE conversation_id = ?').get(conversationId);
}

function parseResult(raw) {
    const parsed = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, '').trim());
    if (typeof parsed?.summary !== 'string' || !parsed.summary.trim() || parsed.summary.length > 3000 ||
        !Array.isArray(parsed.facts)) throw new Error('Invalid memory model response');
    return { summary: parsed.summary.trim(), facts: parsed.facts.slice(0, 15) };
}

function nextChunk(messages, start, offset) {
    let index = start;
    let position = offset;
    let used = 0;
    const parts = [];
    while (index < messages.length && index - start < 24) {
        const message = messages[index];
        if ((message.role === 'user' || message.role === 'assistant') &&
            typeof message.content === 'string' && message.content.length > position) {
            const piece = message.content.slice(position, position + MAX_CHUNK_CHARS - used);
            if (piece.trim()) parts.push(`${message.role}: ${piece}`);
            used += piece.length;
            position += piece.length;
            if (position < message.content.length) break;
        }
        index++;
        position = 0;
        if (used >= MAX_CHUNK_CHARS) break;
    }
    return { index, offset: position, material: parts.join('\n\n') };
}

async function processConversation(conversation, config, { finalize = false, callModel = callLlm, isCurrent = () => true } = {}) {
    const row = getSummaryRow(conversation.id);
    const start = row?.message_count_at_last_summary || 0;
    const startOffset = row?.message_offset_at_last_summary || 0;
    if (start >= conversation.messages.length) {
        if (finalize && row && !row.finalized) {
            getDb().prepare('UPDATE conversation_summaries SET finalized = 1 WHERE conversation_id = ?').run(conversation.id);
        }
        return false;
    }
    const chunk = nextChunk(conversation.messages, start, startOffset);
    if (!finalize && chunk.index - start < BATCH_MESSAGES && !chunk.offset) return false;
    if (!chunk.material) {
        if (!isCurrent()) return false;
        getDb().prepare(`INSERT INTO conversation_summaries
            (conversation_id, message_count_at_last_summary, message_offset_at_last_summary, finalized, updated_at)
            VALUES (?, ?, ?, ?, ?) ON CONFLICT(conversation_id) DO UPDATE SET
            message_count_at_last_summary = excluded.message_count_at_last_summary,
            message_offset_at_last_summary = excluded.message_offset_at_last_summary,
            finalized = excluded.finalized, updated_at = excluded.updated_at`)
            .run(conversation.id, chunk.index, chunk.offset,
                finalize && chunk.index === conversation.messages.length && !chunk.offset ? 1 : 0,
                new Date().toISOString());
        return true;
    }
    const prior = (row?.rolling_summary || '').slice(0, 3000);
    const prompt = `Maintain a concise memory of a companion conversation. Return ONLY JSON:
{"summary":"updated conversation summary under 3000 characters","facts":[{"category":"identity|preference|want|need|project|other","key":"stable short key","value":"lasting fact"}]}
Include only durable facts explicitly stated by the USER. Keep wants, needs, preferences, and identity; exclude assistant claims, guesses, transient tasks and secrets. Reuse the exact category and key of an existing fact for the same topic; do not invent synonyms or reorder its key. If nothing durable, return [] for facts.
Existing facts:
${getFactsText(chunk.material, 2500) || '(none)'}
Prior summary: ${prior || '(none)'}
New conversation material:
${chunk.material}`;
    const result = parseResult(await callModel([{ role: 'system', content: prompt }], config));
    if (!isCurrent()) return false;
    const db = getDb();
    db.exec('BEGIN IMMEDIATE');
    try {
        const latest = getSummaryRow(conversation.id);
        if ((latest?.message_count_at_last_summary || 0) !== start ||
            (latest?.message_offset_at_last_summary || 0) !== startOffset) {
            db.exec('ROLLBACK');
            return false;
        }
        db.prepare(`INSERT INTO conversation_summaries
            (conversation_id, rolling_summary, final_summary,
             message_count_at_last_summary, message_offset_at_last_summary, finalized, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(conversation_id) DO UPDATE SET rolling_summary = excluded.rolling_summary,
            final_summary = excluded.final_summary,
            message_count_at_last_summary = excluded.message_count_at_last_summary,
            message_offset_at_last_summary = excluded.message_offset_at_last_summary,
            finalized = excluded.finalized, updated_at = excluded.updated_at`)
            .run(conversation.id, result.summary, result.summary, chunk.index, chunk.offset,
                finalize && chunk.index === conversation.messages.length && !chunk.offset ? 1 : 0,
                new Date().toISOString());
        for (const fact of result.facts) {
            if (!fact || !['identity', 'preference', 'want', 'need', 'project', 'other'].includes(fact.category)) continue;
            try { upsertFact(fact.category, fact.key, fact.value, conversation.id); }
            catch { /* Ignore malformed individual facts; keep the batch. */ }
        }
        db.exec('COMMIT');
        return true;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
}

module.exports = { processConversation, getSummaryRow, BATCH_MESSAGES };
