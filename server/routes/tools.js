// ============================================
// server/routes/tools.js — tool listing + MCP config quick-open
// ============================================
const express = require('express');
const path = require('path');
const { exec } = require('child_process');
const { getToolSummaries } = require('../tools');

const router = express.Router();

router.get('/tools', (req, res) => {
    res.json({ tools: getToolSummaries() });
});


// configPath is hardcoded, never taken from the request — don't change that,
// it's what keeps this endpoint from being an arbitrary command execution hole.
router.post('/tools/open-config', (req, res) => {
    const configPath = path.join(__dirname, '../tools/mcpServers.config.js');
    exec(`code "${configPath}"`, (err) => {
        if (err) {
            console.error('Failed to open MCP config in editor:', err);
            return res.status(500).json({
                error: 'Could not open the file. Is VS Code\'s "code" command on your PATH?',
            });
        }
        res.json({ ok: true });
    });
});

module.exports = router;