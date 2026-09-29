// Serialize complete read/modify/write turns, including deletes, per conversation.
const pending = new Map();

async function withConversationLock(id, task) {
    const previous = pending.get(id) || Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    pending.set(id, current);
    await previous;
    try { return await task(); }
    finally {
        release();
        if (pending.get(id) === current) pending.delete(id);
    }
}

module.exports = { withConversationLock };
