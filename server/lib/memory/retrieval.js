// ============================================
// server/lib/memory/retrieval.js — heuristic-gated vector search over past conversations
// ============================================
const { getDb, toVecBuffer } = require('./db.js');
const { embedText } = require('./embeddings.js');

const TOP_K = 3;

// First-guess heuristic (same spirit as ChatBox.jsx's SCREEN_KEYWORDS) —
// only bother embedding + searching when the message actually seems to
// reference something outside the current conversation. Expect to tune
// based on false positives/negatives in practice.
const RETRIEVAL_TRIGGERS = /\b(remember|recall|last time|earlier|before|previously|we (talked|discussed|worked on)|you (said|mentioned|told me)|again)\b/i;

function shouldRetrieve(userText) {
    return RETRIEVAL_TRIGGERS.test(userText);
}

// Two-step query (vector search, then resolve rowids against memory_chunks)
// rather than a single JOIN — sqlite-vec is pre-v1 and its join behavior
// with regular tables isn't something to lean on yet; this is the safer,
// documented pattern.
async function retrieveRelevantChunks(userText, currentConversationId) {
    const db = getDb();
    const queryVector = await embedText(userText);

    const matches = db.prepare(`
        SELECT rowid, distance
        FROM memory_vectors
        WHERE embedding MATCH ?
        ORDER BY distance
        LIMIT ?
    `).all(toVecBuffer(queryVector), TOP_K);

    if (matches.length === 0) return [];

    const placeholders = matches.map(() => '?').join(',');
    const chunkRows = db.prepare(`
        SELECT id, conversation_id, chunk_text
        FROM memory_chunks
        WHERE id IN (${placeholders})
    `).all(...matches.map(m => m.rowid));

    const distanceById = new Map(matches.map(m => [m.rowid, m.distance]));

    // Skip chunks from the conversation currently in progress — that
    // content is already live in context, re-injecting it is just noise.
    return chunkRows
        .filter(r => r.conversation_id !== currentConversationId)
        .map(r => ({ ...r, distance: distanceById.get(r.id) }))
        .sort((a, b) => a.distance - b.distance);
}

module.exports = { shouldRetrieve, retrieveRelevantChunks };