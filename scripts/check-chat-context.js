// Counts prompt components without printing conversation text or memory values.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('../server/settings').getSettings();
const bytes = value => value == null ? 0 : Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
const handlers = ['music', 'alarms', 'weather', 'web', 'documents', 'filesystem', 'screen', 'ankiReview', 'outfits'];
const definitions = handlers.flatMap(name => require(`../server/tools/handlers/${name}`).definitions);
const chats = require('../server/conversations');
const recent = chats.listConversations().filter(item => item.characterId === config.currentCharacter ||
    (!item.characterId && (!config.currentCharacter || config.currentCharacter.endsWith('.vrm')))).slice(0, 3);
const result = {
    systemPromptBytes: bytes(require('../server/lib/systemPrompt').readSystemPrompt()),
    characterPersonalityBytes: bytes(config.character?.personality || ''),
    localTools: { count: definitions.length, schemaBytes: bytes(definitions) },
    memoryContextMaximumBytes: Math.min(8000, Math.max(600, (Number(process.env.COMPANION_MEMORY_CONTEXT_TOKENS) || 2000) * 3)),
    recentChats: recent.map(item => {
        const conversation = chats.loadConversation(item.id);
        return { updatedAt: item.updatedAt, messages: conversation.messages.length,
            textBytes: conversation.messages.reduce((sum, message) => sum + bytes(message.content), 0),
            toolResultBytes: conversation.messages.filter(message => message.role === 'tool').reduce((sum, message) => sum + bytes(message.content), 0),
            lastUserBytes: bytes(conversation.messages.findLast(message => message.role === 'user')?.content),
            attachments: conversation.messages.reduce((sum, message) => sum + (message.attachments?.length || 0), 0) };
    }),
};
const memoryFile = path.join(__dirname, '../server/data/memory.db');
if (fs.existsSync(memoryFile)) {
    const db = new DatabaseSync(memoryFile, { readOnly: true });
    try {
        result.memory = { schema: db.prepare('PRAGMA user_version').get().user_version,
            facts: db.prepare('SELECT count(*) n FROM facts').get().n,
            jobs: db.prepare('SELECT status,count(*) n FROM memory_jobs GROUP BY status').all() };
    } finally { db.close(); }
}
console.log(JSON.stringify(result, null, 2));
if (process.argv.includes('--running-tools')) {
    const axios = require('axios');
    const token = JSON.parse(fs.readFileSync(path.join(__dirname, '../server/data/auth.json'), 'utf8')).token;
    axios.get(`http://127.0.0.1:${process.env.PORT || 3000}/api/tools`, {
        headers: { 'x-app-token': token }, proxy: false, timeout: 5000,
    }).then(response => {
        const sources = {};
        for (const tool of response.data.tools || []) {
            const entry = sources[tool.source] ||= { count: 0, descriptionBytes: 0 };
            entry.count++; entry.descriptionBytes += bytes(tool.description);
        }
        console.log(JSON.stringify({ runningToolSources: sources }, null, 2));
    }).catch(error => { console.error(error.code || error.name); process.exitCode = 1; });
}
