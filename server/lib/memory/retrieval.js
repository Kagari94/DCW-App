const { getDb } = require('./db.js');

const RETRIEVAL_TRIGGERS = /\b(remember|recall|earlier|before|previously|last time|again|discussed|talked|mentioned|you said|we decide|we decided|muistatko|muista|aiemmin|ennen|viimeksi|puhuimme|kerroit|sanoit|sovimme)\b/iu;
const STOP = new Set(['remember', 'recall', 'earlier', 'before', 'previously', 'last', 'time', 'again', 'we', 'you', 'the', 'and', 'did', 'what', 'about', 'said', 'decide', 'decided', 'muistatko', 'muista', 'aiemmin', 'ennen', 'viimeksi', 'me', 'sinä', 'ja', 'mikä', 'mitä', 'sanoit', 'sovimme']);

function shouldRetrieve(text) { return RETRIEVAL_TRIGGERS.test(text || ''); }

function queryTerms(text) {
    return [...new Set(((text || '').match(/[\p{L}\p{N}]{3,}/gu) || [])
        .map(term => term.toLowerCase()).filter(term => !STOP.has(term)))].slice(0, 12);
}

async function retrieveRelevantChunks(text, currentConversationId) {
    const terms = queryTerms(text);
    if (!terms.length) return [];
    // A short prefix also catches common Finnish inflections without a model.
    const query = terms.map(term => term.length >= 7 ?
        `"${term.slice(0, -3)}"*` : `"${term}"`).join(' OR ');
    return getDb().prepare(`SELECT s.conversation_id, s.final_summary AS chunk_text,
        bm25(summary_fts) AS score FROM summary_fts
        JOIN conversation_summaries s ON s.rowid = summary_fts.rowid
        WHERE summary_fts MATCH ? AND s.conversation_id != ? AND s.final_summary IS NOT NULL
        ORDER BY score LIMIT 3`).all(query, currentConversationId || '').map(row => ({
        ...row, chunk_text: row.chunk_text.slice(0, 1200),
    }));
}

module.exports = { shouldRetrieve, queryTerms, retrieveRelevantChunks };
