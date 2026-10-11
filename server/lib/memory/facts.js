const { createHash } = require('node:crypto');
const { getDb, statement, touchMemory } = require('./db.js');
const { queryTerms, ftsQuery } = require('./retrieval.js');
const { normalizedValue, topicIdentity, registerAlias, mergeFactRows } = require('./factIdentity.js');

const CATEGORIES = ['identity', 'preference', 'want', 'need', 'project', 'other'];
const PRIORITY = `pinned DESC, CASE category WHEN 'need' THEN 0 WHEN 'want' THEN 1
    WHEN 'identity' THEN 2 WHEN 'preference' THEN 3 ELSE 4 END, updated_at DESC, id DESC`;
const HEADER = 'Known user preferences, wants, needs and other lasting facts:\n';
function clean(value, max, label) {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new Error(`${label} must be 1-${max} characters`);
    return value.trim();
}
function evidenceHash(text) { return createHash('sha256').update(normalizedValue(text)).digest('hex'); }
function getAllFacts() { return statement(`SELECT * FROM facts ORDER BY ${PRIORITY}`).all(); }
function getProposals() {
    return statement(`SELECT p.*, f.category, f.key, f.value AS current_value FROM fact_proposals p
        JOIN facts f ON f.id = p.fact_id WHERE p.status = 'pending' ORDER BY p.created_at DESC, p.id DESC`).all();
}
function getFactHistory(id) {
    return {
        revisions: statement('SELECT * FROM fact_revisions WHERE fact_id = ? ORDER BY id DESC').all(id),
        proposals: statement('SELECT * FROM fact_proposals WHERE fact_id = ? ORDER BY id DESC').all(id),
        originals: statement('SELECT original_fact, merged_at FROM fact_merge_archive WHERE fact_id = ? ORDER BY id DESC').all(id),
    };
}
function isForgotten(key, value = '', quote = '') {
    if (statement('SELECT 1 FROM forgotten_facts WHERE topic_identity = ? LIMIT 1').get(topicIdentity(key))) return true;
    return [value, quote].filter(Boolean).some(text =>
        statement('SELECT 1 FROM forgotten_evidence WHERE hash = ?').get(evidenceHash(text)));
}

function upsertFact(category, key, value, sourceConversationId = null, sourceKind = 'automatic', pinned = false, evidence = {}) {
    category = clean(category, 40, 'Category').toLowerCase();
    if (!CATEGORIES.includes(category)) throw new Error('Invalid fact category');
    key = clean(key, 80, 'Key').toLowerCase();
    value = clean(value, 600, 'Value');
    const identity = topicIdentity(key), normalized = normalizedValue(value);
    const sourceIndex = Number.isSafeInteger(evidence.messageIndex) ? evidence.messageIndex : null;
    const quote = typeof evidence.quote === 'string' ? evidence.quote.slice(0, 1000) : null;
    if (sourceKind === 'automatic' && isForgotten(key, value, quote)) return null;
    const db = getDb();
    db.exec('SAVEPOINT fact_write');
    try {
        if (sourceKind === 'manual') {
            statement('DELETE FROM forgotten_facts WHERE topic_identity = ?').run(identity);
            statement('DELETE FROM forgotten_evidence WHERE topic_identity = ?').run(identity);
        }
        const related = statement(`SELECT * FROM facts WHERE category=? AND topic_identity=?
            UNION SELECT f.* FROM fact_aliases a JOIN facts f ON f.id=a.fact_id
            WHERE a.category=? AND a.topic_identity=?`).all(category, identity, category, identity);
        const existing = statement('SELECT * FROM facts WHERE category=? AND key=?').get(category,key) ||
            statement(`SELECT f.* FROM facts f JOIN fact_aliases a ON a.fact_id = f.id
                WHERE a.category = ? AND a.key = ?`).get(category, key) ||
            related.find(row => row.normalized_value === normalized) || related.sort((a,b) =>
                Number(b.source_kind === 'manual')-Number(a.source_kind === 'manual') || b.pinned-a.pinned || a.id-b.id)[0];
        const now = new Date().toISOString();
        let id = existing?.id;
        if (!existing) {
            id = Number(statement(`INSERT INTO facts
                (category,key,value,topic_identity,normalized_value,source_conversation_id,source_kind,pinned,
                 source_message_index,source_quote,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
                .run(category, key, value, identity, normalized, sourceConversationId, sourceKind, pinned ? 1 : 0,
                    sourceIndex, quote, now, now).lastInsertRowid);
        } else if (existing.normalized_value !== normalized && sourceKind === 'automatic') {
            statement(`INSERT OR IGNORE INTO fact_proposals
                (fact_id,value,normalized_value,source_conversation_id,source_message_index,source_quote,created_at)
                VALUES (?,?,?,?,?,?,?)`).run(id, value, normalized, sourceConversationId, sourceIndex, quote, now);
        } else if (existing.normalized_value !== normalized) {
            statement(`INSERT INTO fact_revisions
                (fact_id,value,source_conversation_id,source_message_index,source_quote,changed_at) VALUES (?,?,?,?,?,?)`)
                .run(id, existing.value, existing.source_conversation_id, existing.source_message_index, existing.source_quote, now);
            statement(`UPDATE facts SET value=?, normalized_value=?, topic_identity=?, source_conversation_id=?, source_kind='manual',
                source_message_index=?,source_quote=?,updated_at=? WHERE id=?`)
                .run(value, normalized, identity, sourceConversationId, sourceIndex, quote, now, id);
            statement("UPDATE fact_proposals SET status='superseded' WHERE fact_id=? AND status='pending'").run(id);
        }
        if (existing && (pinned || sourceKind === 'manual')) {
            statement(`UPDATE facts SET pinned = max(pinned, ?), source_kind = CASE WHEN ? = 'manual'
                THEN 'manual' ELSE source_kind END WHERE id = ?`).run(pinned ? 1 : 0, sourceKind, id);
        }
        registerAlias(db, category, key, id);
        const stored = statement('SELECT * FROM facts WHERE id = ?').get(id);
        const duplicates = statement('SELECT * FROM facts WHERE category=? AND topic_identity=? AND normalized_value=?')
            .all(category, stored.topic_identity, stored.normalized_value);
        id = mergeFactRows(db, duplicates);
        touchMemory();
        db.exec('RELEASE fact_write');
        return id;
    } catch (error) { db.exec('ROLLBACK TO fact_write'); db.exec('RELEASE fact_write'); throw error; }
}

function updateFact(id, changes) {
    const fact = statement('SELECT * FROM facts WHERE id = ?').get(id);
    if (!fact) return false;
    if (changes.pinned !== undefined && typeof changes.pinned !== 'boolean') throw new Error('Pinned must be a boolean');
    const db = getDb();
    db.exec('SAVEPOINT fact_edit');
    try {
        const canonical = changes.value !== undefined ? upsertFact(fact.category, fact.key, changes.value, null, 'manual', Boolean(fact.pinned)) : id;
        if (changes.pinned !== undefined) statement('UPDATE facts SET pinned=?,updated_at=? WHERE id=?')
            .run(changes.pinned ? 1 : 0, new Date().toISOString(), canonical);
        touchMemory();
        db.exec('RELEASE fact_edit');
        return canonical;
    } catch (error) { db.exec('ROLLBACK TO fact_edit'); db.exec('RELEASE fact_edit'); throw error; }
}

function resolveProposal(id, accept) {
    const proposal = statement("SELECT * FROM fact_proposals WHERE id=? AND status='pending'").get(id);
    if (!proposal) return false;
    const fact = statement('SELECT * FROM facts WHERE id=?').get(proposal.fact_id);
    if (!fact) return false;
    const db = getDb();
    db.exec('SAVEPOINT proposal_review');
    try {
        if (accept) upsertFact(fact.category, fact.key, proposal.value, proposal.source_conversation_id, 'manual', Boolean(fact.pinned),
            { messageIndex: proposal.source_message_index, quote: proposal.source_quote });
        statement('UPDATE fact_proposals SET status=? WHERE id=?').run(accept ? 'accepted' : 'dismissed', id);
        touchMemory();
        db.exec('RELEASE proposal_review');
        return true;
    } catch (error) { db.exec('ROLLBACK TO proposal_review'); db.exec('RELEASE proposal_review'); throw error; }
}

function forgetFact(id, conversationCounts = []) {
    const db = getDb();
    db.exec('BEGIN IMMEDIATE');
    try {
        const fact = statement('SELECT * FROM facts WHERE id=?').get(id);
        if (!fact) { db.exec('COMMIT'); return false; }
        const now = new Date().toISOString();
        const aliases = statement('SELECT key FROM fact_aliases WHERE fact_id=?').all(id);
        for (const key of new Set([fact.key, ...aliases.map(row => row.key)])) {
            statement(`INSERT OR REPLACE INTO forgotten_facts(category,key,topic_identity,forgotten_at) VALUES (?,?,?,?)`)
                .run(fact.category, key, topicIdentity(key), now);
        }
        const history = getFactHistory(id);
        const originals = history.originals.map(row => JSON.parse(row.original_fact));
        for (const row of [fact, ...history.revisions, ...history.proposals, ...originals]) {
            for (const text of [row.value, row.source_quote].filter(text => text && text.length >= 20)) {
                statement('INSERT OR IGNORE INTO forgotten_evidence(hash,topic_identity) VALUES (?,?)')
                    .run(evidenceHash(text), fact.topic_identity);
            }
        }
        // Invalidate derived snapshots rather than guessing at semantic redaction.
        // Boundaries prevent old transcripts from re-creating a fact under another name.
        const known = [...conversationCounts,
            ...statement('SELECT conversation_id AS id, message_count_at_last_summary AS count FROM conversation_summaries').all(),
            ...statement('SELECT conversation_id AS id,target_count AS count FROM memory_jobs').all()];
        for (const { id: conversationId, count } of known) {
            statement(`INSERT INTO memory_forget_boundaries VALUES (?,?) ON CONFLICT(conversation_id)
                DO UPDATE SET message_count=max(message_count,excluded.message_count)`).run(conversationId, count);
        }
        statement('UPDATE memory_state SET forget_epoch=forget_epoch+1 WHERE id=1').run();
        db.exec('DELETE FROM memory_embeddings');
        for (const table of ['fact_aliases','fact_merge_archive','fact_revisions','fact_proposals']) {
            db.prepare(`DELETE FROM ${table} WHERE fact_id=?`).run(id);
        }
        statement('DELETE FROM facts WHERE id=?').run(id);
        touchMemory();
        db.exec('COMMIT');
        return true;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
}

function getFactsText(userText = '', maxChars = 4500) {
    const terms = queryTerms(userText);
    const relevant = terms.length ? statement(`SELECT f.* FROM facts_fts JOIN facts f ON f.id=facts_fts.rowid
        WHERE facts_fts MATCH ? ORDER BY bm25(facts_fts) LIMIT 30`).all(ftsQuery(terms)) : [];
    const pinned = statement('SELECT * FROM facts WHERE pinned=1 ORDER BY updated_at DESC,id DESC LIMIT 30').all();
    const core = [...pinned, ...['need','want','identity','preference','project','other'].flatMap(category =>
        statement('SELECT * FROM facts WHERE pinned=0 AND category=? ORDER BY updated_at DESC,id DESC LIMIT 12').all(category))];
    const lines = [], used = new Set();
    let size = HEADER.length;
    const add = (rows, budget) => {
        let spent = 0;
        for (const fact of rows) {
            if (used.has(fact.id) || lines.length >= 30) continue;
            if (isForgotten(fact.key)) continue;
            const line = `- [${fact.category}] ${fact.key}: ${fact.value}`;
            const cost = Buffer.byteLength(line, 'utf8') + 1;
            if (size + cost > maxChars || spent + cost > budget) continue;
            used.add(fact.id); lines.push(line); size += cost; spent += cost;
        }
    };
    add(core.filter(f => f.pinned || f.category === 'identity'), Math.floor(maxChars * 0.35));
    add(relevant, Math.floor(maxChars * 0.65));
    add(core, maxChars);
    return lines.length ? HEADER + lines.join('\n') : '';
}

module.exports = { CATEGORIES, getAllFacts, getFactsText, upsertFact, updateFact, forgetFact,
    getProposals, getFactHistory, resolveProposal, isForgotten, evidenceHash };
