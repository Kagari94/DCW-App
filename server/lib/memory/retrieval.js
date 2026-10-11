const { statement, memoryEpoch, metric } = require('./db.js');
const STOP = new Set(('remember recall earlier before previously last time again discussed talked mentioned we you the and did what about said decide decided muistatko muista aiemmin ennen viimeksi me sinä ja mikä mitä sanoit sovimme tell more please hello thanks thank okay how why when where can could would should does do have has had is are was were it its this that these those with for from into under over not our your my their on of to in at a an but be been will need needs want wants use uses using get new some any as than myös on olen olisi miten milloin missä sekä mutta').split(' '));

function queryTerms(text) {
    return [...new Set(((text || '').normalize('NFC').match(/[\p{L}\p{N}]{3,}/gu) || [])
        .map(term => term.toLowerCase()).filter(term => !STOP.has(term)))].slice(0, 12);
}
for (const word of ['put','find','know','information','details','please','give','show','help','say','tell']) STOP.add(word);
function shouldRetrieve(text) { return queryTerms(text).length > 0; }
function stem(term) { return term.length >= 7 ? term.slice(0, -3) : term; }
function ftsQuery(terms) { return terms.map(term => term.length >= 7 ? `"${stem(term)}"*` : `"${term}"`).join(' OR '); }

function excerpt(text, terms, max = 1200) {
    const lower = text.toLowerCase();
    const positions = terms.map(term => lower.indexOf(stem(term))).filter(position => position >= 0);
    const start = Math.max(0, (positions.length ? Math.min(...positions) : 0) - 200);
    let end = Math.min(text.length, start + max);
    if (end < text.length) {
        const boundary = text.lastIndexOf(' ', end);
        if (boundary > start) end = boundary;
    }
    return (start ? '…' : '') + text.slice(start, end).trim() + (end < text.length ? '…' : '');
}

function safePassage(row) {
    const { isForgotten } = require('./facts.js');
    let topics;
    try { topics = JSON.parse(row.topics_json || '[]'); } catch { return false; }
    for (const topic of topics) {
        if (isForgotten(topic.key, topic.value)) return false;
        const { topicIdentity, normalizedValue } = require('./factIdentity.js');
        const fact = statement('SELECT normalized_value FROM facts WHERE category=? AND topic_identity=? LIMIT 1')
            .get(topic.category, topicIdentity(topic.key));
        if (fact && fact.normalized_value !== normalizedValue(topic.value)) return false;
    }
    return true;
}

async function retrieveRelevantChunks(text, currentConversationId, options = {}) {
    const started = performance.now(), terms = queryTerms(text);
    if (!terms.length) return [];
    const scope = options.characterId || '__legacy__', epoch = memoryEpoch(), query = ftsQuery(terms);
    const passages = statement(`SELECT p.*, bm25(passage_fts) AS score FROM passage_fts
        JOIN memory_passages p ON p.id=passage_fts.rowid WHERE passage_fts MATCH ?
        AND p.character_id=? AND p.forget_epoch=? AND p.conversation_id!=?
        ORDER BY score LIMIT 60`).all(query, scope, epoch, currentConversationId || '');
    const summaries = statement(`SELECT s.conversation_id,s.final_summary AS chunk_text,
        bm25(summary_fts) AS score FROM summary_fts JOIN conversation_summaries s ON s.rowid=summary_fts.rowid
        WHERE summary_fts MATCH ? AND s.character_id=? AND s.forget_epoch=? AND s.conversation_id!=?
        AND NOT EXISTS(SELECT 1 FROM memory_passages p WHERE p.conversation_id=s.conversation_id AND p.forget_epoch=?)
        ORDER BY score LIMIT 60`).all(query, scope, epoch, currentConversationId || '', epoch);
    const raw = [...passages.filter(safePassage), ...summaries];
    const candidates = raw.map(row => {
        const words = new Set((row.chunk_text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []));
        const coverage = terms.reduce((count, term) => count + Number([...words].some(word =>
            term.length >= 7 ? word.startsWith(stem(term)) : word === term)), 0);
        const specific = terms.some(term => term.length >= 7 && [...words].some(word => word.startsWith(stem(term))));
        return { ...row, coverage, specific };
    }).filter(row => row.coverage >= Math.min(2, terms.length) || (row.coverage === 1 && row.specific && raw.length <= 5))
        .sort((a,b) => b.coverage-a.coverage || a.score-b.score);
    const selected = [], seen = new Set();
    for (const row of candidates) {
        if (seen.has(row.conversation_id)) continue;
        seen.add(row.conversation_id);
        selected.push({ ...row, chunk_text: excerpt(row.chunk_text, terms) });
        if (selected.length === 3) break;
    }
    if (options.semantic && !selected.length) {
        try {
            const extra = await require('./semantic.js').recall(text, currentConversationId, scope, passages.map(row => row.id));
            for (const row of extra) if (!seen.has(row.conversation_id) && safePassage(row)) {
                selected.push({ ...row, chunk_text: excerpt(row.chunk_text, terms) });
                seen.add(row.conversation_id);
                if (selected.length === 3) break;
            }
        } catch { metric('semantic_failures'); }
    }
    metric('lookup_count'); metric('lookup_ms', performance.now()-started);
    return selected;
}

module.exports = { shouldRetrieve, queryTerms, ftsQuery, retrieveRelevantChunks, excerpt, safePassage };
