// ============================================
// server/routes/documents.js — serve AI-generated documents, per-conversation
// ============================================
const express = require('express');
const fs = require('fs');
const path = require('path');

const router = express.Router();
const GENERATED_ROOT = path.join(__dirname, '../data/generated');

router.get('/conversations/:conversationId/documents/:storedFilename', (req, res) => {
    const conversationDir = path.resolve(path.join(GENERATED_ROOT, req.params.conversationId));
    const filePath = path.resolve(path.join(conversationDir, req.params.storedFilename));

    if (!filePath.startsWith(conversationDir)) {
        return res.status(400).json({ error: 'Invalid path.' });
    }
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Document not found.' });

    res.download(filePath); // Content-Disposition: attachment — browser downloads instead of navigating
});

module.exports = router;