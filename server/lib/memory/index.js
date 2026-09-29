const { getFactsText } = require('./facts.js');
const { shouldRetrieve, retrieveRelevantChunks } = require('./retrieval.js');
const { deleteConversationMemory } = require('./db.js');
const { createMemoryWorker } = require('./jobs.js');

let worker;
function getWorker() {
    if (!worker) worker = createMemoryWorker({
        store: require('../../conversations'),
        getSettings: require('../../settings').getSettings,
    });
    return worker;
}

function startMemoryWorker() { getWorker().start(); }

async function buildMemoryContext(userText, currentConversationId) {
    const parts = [];
    const factsText = getFactsText(userText);
    if (factsText) parts.push(factsText);
    if (shouldRetrieve(userText)) {
        try {
            const chunks = await retrieveRelevantChunks(userText, currentConversationId);
            if (chunks.length) parts.push('Relevant earlier conversations:\n' +
                chunks.map(chunk => `- ${chunk.chunk_text}`).join('\n'));
        } catch (error) { console.error('Memory retrieval failed:', error); }
    }
    return parts.length ? parts.join('\n\n').slice(0, 8500) : null;
}

function runBackgroundMemoryJobs({ conversation, userText }) {
    getWorker().enqueue(conversation.id, conversation.messages.length, {
        immediate: /\b(remember this|please remember|muista tämä|laita muistiin)\b/iu.test(userText || ''),
    });
}

function finalizeIfSwitchingAway(previousConversation) {
    if (previousConversation) getWorker().enqueue(previousConversation.id,
        previousConversation.messages.length, { immediate: true, finalize: true });
}

module.exports = { buildMemoryContext, runBackgroundMemoryJobs,
    finalizeIfSwitchingAway, startMemoryWorker, deleteConversationMemory };
