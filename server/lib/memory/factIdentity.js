function normalizedValue(value) {
    return value.normalize('NFC').trim().replace(/\s+/gu, ' ').toLowerCase();
}

function topicIdentity(key) {
    return (key.normalize('NFC').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [key])
        .sort().join('_');
}

function registerAlias(db, category, key, factId) {
    db.prepare(`INSERT INTO fact_aliases (category, key, fact_id) VALUES (?, ?, ?)
        ON CONFLICT(category, key) DO UPDATE SET fact_id = excluded.fact_id`)
        .run(category, key, factId);
}

function mergeFactRows(db, rows) {
    if (!rows.length) return null;
    const ordered = [...rows].sort((a, b) =>
        Number(b.source_kind === 'manual') - Number(a.source_kind === 'manual') ||
        b.pinned - a.pinned || a.id - b.id);
    const winner = ordered[0];
    const now = new Date().toISOString();
    for (const row of ordered) registerAlias(db, row.category, row.key, winner.id);
    for (const row of ordered.slice(1)) {
        // Preserve the complete original record and its history under the survivor.
        db.prepare('INSERT INTO fact_merge_archive (fact_id, original_fact, merged_at) VALUES (?, ?, ?)')
            .run(winner.id, JSON.stringify(row), now);
        db.prepare('UPDATE fact_revisions SET fact_id = ? WHERE fact_id = ?').run(winner.id, row.id);
        db.prepare('UPDATE fact_merge_archive SET fact_id = ? WHERE fact_id = ?').run(winner.id, row.id);
        db.prepare('UPDATE fact_aliases SET fact_id = ? WHERE fact_id = ?').run(winner.id, row.id);
        db.prepare('DELETE FROM facts WHERE id = ?').run(row.id);
    }
    db.prepare('UPDATE facts SET pinned = ?, updated_at = ? WHERE id = ?')
        .run(rows.some(row => row.pinned) ? 1 : 0,
            rows.map(row => row.updated_at).sort().at(-1), winner.id);
    return winner.id;
}

function consolidateDuplicateFacts(db) {
    const groups = new Map();
    for (const fact of db.prepare('SELECT * FROM facts ORDER BY id').all()) {
        registerAlias(db, fact.category, fact.key, fact.id);
        const identity = JSON.stringify([fact.category, topicIdentity(fact.key), normalizedValue(fact.value)]);
        if (!groups.has(identity)) groups.set(identity, []);
        groups.get(identity).push(fact);
    }
    let merged = 0;
    for (const rows of groups.values()) {
        if (rows.length > 1) {
            mergeFactRows(db, rows);
            merged += rows.length - 1;
        }
    }
    return merged;
}

module.exports = { normalizedValue, topicIdentity, registerAlias, mergeFactRows, consolidateDuplicateFacts };
