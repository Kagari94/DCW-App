const { getDb } = require('./db.js');
const { queryTerms } = require('./retrieval.js');
const { normalizedValue, topicIdentity, registerAlias, mergeFactRows } = require('./factIdentity.js');

function clean(value, max, label) {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
        throw new Error(`${label} must be 1-${max} characters`);
    }
    return value.trim();
}

function getAllFacts() {
    return getDb().prepare(`SELECT id, category, key, value, pinned, source_kind,
        source_conversation_id, created_at, updated_at FROM facts
        ORDER BY pinned DESC,
        CASE category WHEN 'need' THEN 0 WHEN 'want' THEN 1
            WHEN 'identity' THEN 2 WHEN 'preference' THEN 3 ELSE 4 END,
        updated_at DESC, id DESC`).all();
}

function upsertFact(category, key, value, sourceConversationId = null, sourceKind = 'automatic', pinned = false) {
    category = clean(category, 40, 'Category').toLowerCase();
    key = clean(key, 80, 'Key').toLowerCase();
    value = clean(value, 600, 'Value');
    const db = getDb();
    const identity = topicIdentity(key);
    const normalized = normalizedValue(value);
    const forgottenKeys = db.prepare('SELECT key FROM forgotten_facts WHERE category = ?').all(category)
        .filter(row => topicIdentity(row.key) === identity);
    if (sourceKind === 'automatic' && forgottenKeys.length) return null;
    db.exec('SAVEPOINT fact_write');
    try {
        if (sourceKind === 'manual') {
            for (const row of forgottenKeys) {
                db.prepare('DELETE FROM forgotten_facts WHERE category = ? AND key = ?').run(category, row.key);
            }
        }
        const rows = db.prepare('SELECT * FROM facts WHERE category = ?').all(category);
        const aliases = db.prepare('SELECT key, fact_id FROM fact_aliases WHERE category = ?').all(category);
        const relatedIds = new Set(aliases.filter(row => topicIdentity(row.key) === identity).map(row => row.fact_id));
        const related = rows.filter(row => topicIdentity(row.key) === identity || relatedIds.has(row.id));
        const exactAlias = aliases.find(row => row.key === key);
        const existing = rows.find(row => row.key === key) ||
            rows.find(row => row.id === exactAlias?.fact_id) ||
            related.find(row => normalizedValue(row.value) === normalized) ||
            (related.length === 1 ? related[0] : null);
        const id = writeFact(db, existing, { category, key, value, normalized,
            sourceConversationId, sourceKind, pinned });
        registerAlias(db, category, key, id);
        const stored = db.prepare('SELECT key, value FROM facts WHERE id = ?').get(id);
        const duplicates = db.prepare('SELECT * FROM facts WHERE category = ?').all(category)
            .filter(row => topicIdentity(row.key) === topicIdentity(stored.key) &&
                normalizedValue(row.value) === normalizedValue(stored.value));
        const canonicalId = mergeFactRows(db, duplicates);
        db.exec('RELEASE fact_write');
        return canonicalId;
    } catch (error) {
        db.exec('ROLLBACK TO fact_write');
        db.exec('RELEASE fact_write');
        throw error;
    }
}

function writeFact(db, existing, { category, key, value, normalized, sourceConversationId, sourceKind, pinned }) {
    const now = new Date().toISOString();
    if (existing) {
        if (normalizedValue(existing.value) === normalized ||
            (sourceKind === 'automatic' && existing.source_kind === 'manual')) {
            db.prepare('UPDATE facts SET pinned = ?, source_kind = ? WHERE id = ?')
                .run(pinned || existing.pinned ? 1 : 0,
                    sourceKind === 'manual' ? 'manual' : existing.source_kind, existing.id);
            return existing.id;
        }
        db.prepare(`INSERT INTO fact_revisions (fact_id, value, source_conversation_id, changed_at)
            VALUES (?, ?, ?, ?)`).run(existing.id, existing.value, existing.source_conversation_id, now);
        db.prepare(`UPDATE facts SET value = ?, source_conversation_id = ?, source_kind = ?,
            pinned = ?, updated_at = ? WHERE id = ?`).run(value, sourceConversationId,
            sourceKind, pinned || existing.pinned ? 1 : 0, now, existing.id);
        return existing.id;
    }
    return Number(db.prepare(`INSERT INTO facts
        (category, key, value, source_conversation_id, source_kind, pinned, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(category, key, value, sourceConversationId,
        sourceKind, pinned ? 1 : 0, now, now).lastInsertRowid);
}

function updateFact(id, changes) {
    const db = getDb();
    const fact = db.prepare('SELECT * FROM facts WHERE id = ?').get(id);
    if (!fact) return false;
    if (changes.pinned !== undefined && typeof changes.pinned !== 'boolean') throw new Error('Pinned must be a boolean');
    db.exec('SAVEPOINT fact_edit');
    try {
        const canonicalId = changes.value !== undefined ?
            upsertFact(fact.category, fact.key, changes.value, null, 'manual', Boolean(fact.pinned)) : id;
        if (changes.pinned !== undefined) {
            db.prepare('UPDATE facts SET pinned = ?, updated_at = ? WHERE id = ?')
                .run(changes.pinned ? 1 : 0, new Date().toISOString(), canonicalId);
        }
        db.exec('RELEASE fact_edit');
        return canonicalId;
    } catch (error) {
        db.exec('ROLLBACK TO fact_edit');
        db.exec('RELEASE fact_edit');
        throw error;
    }
}

function forgetFact(id) {
    const db = getDb();
    db.exec('BEGIN IMMEDIATE');
    try {
        const fact = db.prepare('SELECT category, key, value FROM facts WHERE id = ?').get(id);
        if (!fact) { db.exec('COMMIT'); return false; }
        const now = new Date().toISOString();
        const keys = [fact.key, ...db.prepare('SELECT key FROM fact_aliases WHERE fact_id = ?').all(id).map(row => row.key)];
        for (const key of new Set(keys)) {
            db.prepare('INSERT OR REPLACE INTO forgotten_facts (category, key, forgotten_at) VALUES (?, ?, ?)')
                .run(fact.category, key, now);
        }
        db.prepare('DELETE FROM fact_aliases WHERE fact_id = ?').run(id);
        db.prepare('DELETE FROM fact_merge_archive WHERE fact_id = ?').run(id);
        db.prepare('DELETE FROM fact_revisions WHERE fact_id = ?').run(id);
        const removed = db.prepare('DELETE FROM facts WHERE id = ?').run(id).changes > 0;
        db.exec('COMMIT');
        return removed;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
}

function getFactsText(userText = '', maxChars = 4500) {
    const lines = [];
    let size = 0;
    const terms = queryTerms(userText);
    const ranked = getAllFacts().map((fact, index) => {
        const content = `${fact.category} ${fact.key.replaceAll('_', ' ')} ${fact.value}`.toLowerCase();
        const score = terms.reduce((count, term) => count + (content.includes(term) ? 1 : 0), 0);
        return { fact, index, score };
    }).sort((a, b) => b.score - a.score || a.index - b.index);
    for (const { fact } of ranked) {
        const line = `- [${fact.category}] ${fact.key}: ${fact.value}`;
        if (lines.length >= 30 || size + line.length > maxChars) break;
        lines.push(line);
        size += line.length;
    }
    return lines.length ? `Known user preferences, wants, needs and other lasting facts:\n${lines.join('\n')}` : '';
}

module.exports = { getAllFacts, getFactsText, upsertFact, updateFact, forgetFact };
