// ============================================
// server/conversations.js — persistent chat session storage
// ============================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONV_DIR = path.join(__dirname, 'data', 'conversations');

function ensureDir() {
    if (!fs.existsSync(CONV_DIR)) fs.mkdirSync(CONV_DIR, { recursive: true });
}

function listConversations() {
    ensureDir();
    const files = fs.readdirSync(CONV_DIR).filter(f => f.endsWith('.json'));
    const list = files.map(f => {
        const data = JSON.parse(fs.readFileSync(path.join(CONV_DIR, f), 'utf8'));
        return { id: data.id, title: data.title, updatedAt: data.updatedAt };
    });
    return list.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

function loadConversation(id) {
    ensureDir();
    const filePath = path.join(CONV_DIR, `${id}.json`);
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function saveConversation(conversation) {
    ensureDir();
    conversation.updatedAt = new Date().toISOString();
    fs.writeFileSync(
        path.join(CONV_DIR, `${conversation.id}.json`),
        JSON.stringify(conversation, null, 2)
    );
    return conversation;
}

function createConversation(systemPrompt) {
    const id = crypto.randomUUID();
    const conversation = {
        id,
        title: 'New conversation',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages: [{ role: 'system', content: systemPrompt }],
    };
    saveConversation(conversation);
    return conversation;
}

function deleteConversation(id) {
    ensureDir();
    const filePath = path.join(CONV_DIR, `${id}.json`);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

// Auto-title from the first user message, truncated
function maybeSetTitle(conversation) {
    if (conversation.title !== 'New conversation') return;
    const firstUserMsg = conversation.messages.find(m => m.role === 'user');
    if (firstUserMsg) {
        conversation.title = firstUserMsg.content.slice(0, 40) + (firstUserMsg.content.length > 40 ? '…' : '');
    }
}

module.exports = {
    listConversations,
    loadConversation,
    saveConversation,
    createConversation,
    deleteConversation,
    maybeSetTitle,
};