import { useState, useEffect } from 'react';
import { apiJson } from '../apiConfig';

function ConversationList({ activeId, activeTitle, onSelect, onNew }) {
    const [conversations, setConversations] = useState([]);

    useEffect(() => {
        loadList().catch(error => alert(error.message));
    }, [activeId]);

    async function loadList() {
        const data = await apiJson('/api/conversations');
        setConversations(data.conversations || []);
    }

    async function handleNew() {
        const conversation = await apiJson('/api/conversations', { method: 'POST' });
        await loadList();
        onNew(conversation.id);
    }

    async function handleDelete() {
        if (!activeId) return;
        if (!confirm('Delete this conversation?')) return;

        await apiJson(`/api/conversations/${activeId}`, {
            method: 'DELETE',
        });

        const data = await apiJson('/api/conversations');
        const remaining = data.conversations || [];

        if (remaining.length > 0) {
            onSelect(remaining[0].id);
        } else {
            await handleNew();
        }
    }

    return (
        <div className="conversation-list">
            <select
                className="conversation-select"
                value={activeId || ''}
                onChange={(e) => onSelect(e.target.value)}
            >
                {conversations.map(c => (
                    <option key={c.id} value={c.id}>{c.id === activeId && activeTitle ? activeTitle : c.title}</option>
                ))}
            </select>
            <button
                onClick={() => handleNew().catch(error => alert(error.message))}
                title="New chat"
                className="conversation-btn conversation-btn-new"
            >
                + New
            </button>
            <button
                onClick={() => handleDelete().catch(error => alert(error.message))}
                title="Delete this chat"
                disabled={!activeId}
                className="conversation-btn conversation-btn-delete"
            >
                🗑
            </button>
        </div>
    );
}

export default ConversationList;