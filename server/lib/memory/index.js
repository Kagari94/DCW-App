// ============================================
// server/lib/memory/index.js — public API for the memory system
// ============================================
const { getFactsText, extractFactsFromExchange } = require('./facts.js');
const { shouldRetrieve, retrieveRelevantChunks } = require('./retrieval.js');
const { maybeRollingSummarize, finalizeSummary } = require('./summaries.js');

// Builds the text injected as a fresh system message every request — facts
// are always included (cheap, deterministic); retrieved chunks only show up
// when retrieval.js's heuristic thinks the message needs them. Returns null
// when there's nothing worth injecting, so the caller can skip the message
// entirely rather than injecting an empty one.
async function buildMemoryContext(userText, currentConversationId) {
    const parts = [];

    const factsText = getFactsText();
    if (factsText) parts.push(factsText);

    if (shouldRetrieve(userText)) {
        try {
            const chunks = await retrieveRelevantChunks(userText, currentConversationId);
            if (chunks.length > 0) {
                const chunkText = chunks.map(c => `- ${c.chunk_text}`).join('\n');
                parts.push(`Possibly relevant context from earlier conversations:\n${chunkText}`);
            }
        } catch (err) {
            console.error('⚠️ Memory retrieval failed (non-fatal):', err.message);
        }
    }

    return parts.length > 0 ? parts.join('\n\n') : null;
}

// Fire-and-forget background jobs, called after a reply has already been
// sent and saved — never awaited on the response path. Each job swallows
// its own errors internally, so nothing here can surface to the user.
function runBackgroundMemoryJobs({ conversation, userText, assistantText, config }) {
    extractFactsFromExchange(userText, assistantText, conversation.id, config);
    maybeRollingSummarize(conversation, config);
}

// Called from chat.js when a request comes in for a DIFFERENT conversationId
// than the previous request — finalizes the one being left, so its summary
// becomes searchable memory before it goes quiet.
function finalizeIfSwitchingAway(previousConversation, config) {
    if (!previousConversation) return;
    finalizeSummary(previousConversation, config);
}

module.exports = { buildMemoryContext, runBackgroundMemoryJobs, finalizeIfSwitchingAway };
