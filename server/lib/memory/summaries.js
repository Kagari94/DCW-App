// ============================================
// server/lib/memory/summaries.js — rolling + final conversation summaries
// ============================================
const { getDb, toVecBuffer } = require('./db.js');
const { embedText } = require('./embeddings.js');
const { callLlm } = require('./llmClient.js');

const ROLLING_SUMMARY_EVERY_N_MESSAGES = 12; // tune to taste

function getSummaryRow(conversationId) {
    const db = getDb();
    return db.prepare('SELECT * FROM conversation_summaries WHERE conversation_id = ?').get(conversationId);
}

function upsertSummaryRow(conversationId, fields) {
    const db = getDb();
    const now = new Date().toISOString();
    const existing = getSummaryRow(conversationId);

    if (existing) {
        db.prepare(`
            UPDATE conversation_summaries
            SET rolling_summary = COALESCE(@rolling_summary, rolling_summary),
                final_summary = COALESCE(@final_summary, final_summary),
                message_count_at_last_summary = COALESCE(@message_count_at_last_summary, message_count_at_last_summary),
                finalized = COALESCE(@finalized, finalized),
                updated_at = @now
            WHERE conversation_id = @conversation_id
        `).run({
            conversation_id: conversationId,
            now,
            rolling_summary: fields.rolling_summary ?? null,
            final_summary: fields.final_summary ?? null,
            message_count_at_last_summary: fields.message_count_at_last_summary ?? null,
            finalized: fields.finalized ?? null,
        });
    } else {
        db.prepare(`
            INSERT INTO conversation_summaries
                (conversation_id, rolling_summary, final_summary, message_count_at_last_summary, finalized, updated_at)
            VALUES (@conversation_id, @rolling_summary, @final_summary, @message_count_at_last_summary, @finalized, @now)
        `).run({
            conversation_id: conversationId,
            rolling_summary: fields.rolling_summary ?? null,
            final_summary: fields.final_summary ?? null,
            message_count_at_last_summary: fields.message_count_at_last_summary ?? 0,
            finalized: fields.finalized ?? 0,
            now,
        });
    }
}

// Goes through llmClient.js (no keep-alive + one retry on a dropped
// connection) — these fire right after a streaming reply finishes and
// would otherwise hit "socket hang up" from reusing a dying pooled socket.
function callSummaryModel(prompt, config) {
    return callLlm([{ role: 'system', content: prompt }], config);
}

function conversationTextSince(conversation, sinceIndex) {
    return conversation.messages
        .slice(sinceIndex)
        .filter(m => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.length > 0)
        .map(m => `${m.role}: ${m.content}`)
        .join('\n\n');
}

// Called after saving a turn — checks whether enough NEW messages have
// accumulated since the last rolling summary and, if so, compresses them
// in the background. Folds the previous rolling summary in as context so
// it compounds across the conversation rather than resetting each time.
async function maybeRollingSummarize(conversation, config) {
    try {
        const row = getSummaryRow(conversation.id);
        const lastCount = row?.message_count_at_last_summary || 0;
        const currentCount = conversation.messages.length;

        if (currentCount - lastCount < ROLLING_SUMMARY_EVERY_N_MESSAGES) return;

        const newText = conversationTextSince(conversation, lastCount);
        if (!newText) return;

        const prior = row?.rolling_summary ? `Prior summary:\n${row.rolling_summary}\n\n` : '';
        const prompt = `Summarize this part of an ongoing conversation in a few dense sentences — what was discussed, decided, or built. ${prior}New material:\n${newText}\n\nWrite ONLY the updated summary, folding the prior summary and new material together. No preamble.`;

        const summary = await callSummaryModel(prompt, config);
        if (!summary) return;

        upsertSummaryRow(conversation.id, {
            rolling_summary: summary,
            message_count_at_last_summary: currentCount,
        });
    } catch (err) {
        console.error('⚠️ Rolling summarization failed (non-fatal):', err.message);
    }
}

// Called when a conversation is left (a DIFFERENT conversationId shows up in
// a new /chat request) — produces the summary that becomes this
// conversation's searchable memory chunk. Prefers extending the rolling
// summary with whatever's been added since; falls back to summarizing the
// whole conversation if it was too short to have a rolling summary yet.
async function finalizeSummary(conversation, config) {
    try {
        const row = getSummaryRow(conversation.id);
        if (row?.finalized) return;

        const lastCount = row?.message_count_at_last_summary || 0;
        const newText = conversationTextSince(conversation, lastCount);
        const priorSummary = row?.rolling_summary || '';

        if (!priorSummary && !newText) return; // nothing worth summarizing

        let finalSummary;
        if (priorSummary && !newText) {
            finalSummary = priorSummary;
        } else {
            const priorBlock = priorSummary ? `Prior summary:\n${priorSummary}\n\n` : '';
            const newBlock = newText ? `Remaining material:\n${newText}` : '';
            const prompt = `Write a short final summary (3-6 sentences) of this whole conversation, for future reference — what it was about, key decisions, anything worth recalling later. ${priorBlock}${newBlock}\n\nWrite ONLY the summary, no preamble.`;
            finalSummary = await callSummaryModel(prompt, config);
        }
        if (!finalSummary) return;

        upsertSummaryRow(conversation.id, {
            final_summary: finalSummary,
            finalized: 1,
            message_count_at_last_summary: conversation.messages.length,
        });

        // Embed the final summary as one retrievable chunk — final
        // summaries only (not raw messages), so the vector store stays
        // small and each row maps cleanly to "one past conversation."
        //
        // The embed call happens BEFORE the transaction opens (embedding
        // is async and can be slow on first use — model download/load —
        // and a node:sqlite transaction should stay short and
        // synchronous). Only the two INSERTs are wrapped, so a failure
        // between them can never leave an orphaned chunk-with-no-vector
        // (which retrieval would silently never find, forever) or a
        // vector-with-no-chunk (which would surface as a dangling match
        // during retrieval).
        const vector = await embedText(finalSummary);
        const vecBuffer = toVecBuffer(vector);

        const db = getDb();
        const now = new Date().toISOString();

        db.exec('BEGIN');
        try {
            const info = db.prepare(`
                INSERT INTO memory_chunks (conversation_id, chunk_text, created_at)
                VALUES (?, ?, ?)
            `).run(conversation.id, finalSummary, now);

            db.prepare(`INSERT INTO memory_vectors (rowid, embedding) VALUES (?, ?)`)
                .run(info.lastInsertRowid, vecBuffer);

            db.exec('COMMIT');
        } catch (err) {
            db.exec('ROLLBACK');
            throw err;
        }
    } catch (err) {
        console.error('⚠️ Final summarization failed (non-fatal):', err.message);
    }
}

module.exports = { maybeRollingSummarize, finalizeSummary, getSummaryRow };