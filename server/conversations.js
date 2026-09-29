// ============================================
// server/conversations.js — persistent chat session storage
// ============================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function validateConversationId(id) {
    if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        throw Object.assign(new Error('Invalid conversation ID.'), { status: 400 });
    }
    return id;
}

// Tests inject a temporary directory and filesystem; production uses the defaults.
function createConversationStore(CONV_DIR, io = fs) {
    const fileFor = id => path.join(CONV_DIR, `${validateConversationId(id)}.json`);

    function ensureDir() {
        if (!io.existsSync(CONV_DIR)) io.mkdirSync(CONV_DIR, { recursive: true });
    }

    function listConversations() {
        ensureDir();
        const files = io.readdirSync(CONV_DIR).filter(f => f.endsWith('.json'));
        const list = files.flatMap(f => {
            try {
                const data = loadConversation(f.slice(0, -5));
                return data ? [{ id: data.id, title: data.title, updatedAt: data.updatedAt }] : [];
            } catch (error) {
                console.warn(`Skipping unreadable conversation ${f}: ${error.message}`);
                return [];
            }
        });
        return list.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    }

    function loadConversation(id) {
        const filePath = fileFor(id);
        ensureDir();
        if (!io.existsSync(filePath)) return null;
        const data = JSON.parse(io.readFileSync(filePath, 'utf8'));
        if (data.id !== id || !Array.isArray(data.messages)) throw new Error(`Invalid conversation file: ${id}`);
        return data;
    }

    function saveConversation(conversation) {
        const file = fileFor(conversation.id);
        ensureDir();
        const updated = { ...conversation, updatedAt: new Date().toISOString() };
        const temporary = `${file}.${crypto.randomUUID()}.tmp`;
        try {
            io.writeFileSync(temporary, JSON.stringify(updated, null, 2), { flag: 'wx' });
            io.renameSync(temporary, file);
        } finally {
            io.rmSync(temporary, { force: true });
        }
        Object.assign(conversation, updated);
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
        const filePath = fileFor(id);
        ensureDir();
        if (io.existsSync(filePath)) io.unlinkSync(filePath);
    }

    return { listConversations, loadConversation, saveConversation, createConversation, deleteConversation };
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
    ...createConversationStore(path.join(__dirname, 'data', 'conversations')),
    createConversationStore, validateConversationId, maybeSetTitle,
};
