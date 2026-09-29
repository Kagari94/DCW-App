const fs = require('node:fs');
const path = require('node:path');

function readSystemPrompt() {
    const custom = path.join(__dirname, '../assets/system-prompt.md');
    const fallback = path.join(__dirname, '../assets/system-prompt.example.md');
    return fs.readFileSync(fs.existsSync(custom) ? custom : fallback, 'utf8').trim();
}

module.exports = { readSystemPrompt };
