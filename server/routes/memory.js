const express = require('express');
const { getAllFacts, upsertFact, updateFact, forgetFact } = require('../lib/memory/facts.js');

const router = express.Router();
function factId(req) {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid fact ID');
    return id;
}
function respondError(res, error) { return res.status(400).json({ error: error.message }); }

router.get('/memory/facts', (req, res) => res.json({ facts: getAllFacts() }));

router.post('/memory/facts', (req, res) => {
    try {
        const { category = 'other', key, value, pinned = false } = req.body || {};
        if (typeof pinned !== 'boolean') throw new Error('Pinned must be a boolean');
        const id = upsertFact(category, key, value, null, 'manual', pinned);
        res.status(201).json({ fact: getAllFacts().find(fact => fact.id === id) });
    } catch (error) { respondError(res, error); }
});

router.patch('/memory/facts/:id', (req, res) => {
    try {
        const id = updateFact(factId(req), req.body || {});
        if (!id) return res.status(404).json({ error: 'Fact not found' });
        return res.json({ fact: getAllFacts().find(fact => fact.id === id) });
    } catch (error) { return respondError(res, error); }
});

router.delete('/memory/facts/:id', (req, res) => {
    try {
        if (!forgetFact(factId(req))) return res.status(404).json({ error: 'Fact not found' });
        return res.json({ forgotten: true });
    } catch (error) { return respondError(res, error); }
});

module.exports = router;
