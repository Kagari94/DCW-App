import { useState, useEffect } from 'react';
import { authHeaders } from '../utils/authToken';

const API_BASE = `http://${window.location.hostname}:3000/api`;

function ConversationList({ activeId, activeTitle, onSelect, onNew }) {
    const [conversations, setConversations] = useState([]);

    useEffect(() => {
        loadList();
    }, [activeId]);

    useEffect(() => {
        if (activeTitle) {
            setConversations(prev =>
                prev.map(c => (c.id === activeId ? { ...c, title: activeTitle } : c))
            );
        }
    }, [activeTitle, activeId]);

    async function loadList() {
        const res = await fetch(`${API_BASE}/conversations`, { headers: authHeaders() });
        const data = await res.json();
        setConversations(data.conversations || []);
    }

    async function handleNew() {
        const res = await fetch(`${API_BASE}/conversations`, { method: 'POST', headers: authHeaders() });
        const conversation = await res.json();
        await loadList();
        onNew(conversation.id);
    }

    async function handleDelete() {
        if (!activeId) return;
        if (!confirm('Delete this conversation?')) return;

        await fetch(`${API_BASE}/conversations/${activeId}`, {
            method: 'DELETE',
            headers: authHeaders(),
        });

        const res = await fetch(`${API_BASE}/conversations`, { headers: authHeaders() });
        const data = await res.json();
        const remaining = data.conversations || [];

        if (remaining.length > 0) {
            onSelect(remaining[0].id);
        } else {
            handleNew();
        }
    }

    return (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
            <select
                value={activeId || ''}
                onChange={(e) => onSelect(e.target.value)}
                style={{
                    background: '#2a2a2a', color: '#ccc', border: '1px solid #444',
                    borderRadius: 4, padding: '3px 6px', fontSize: 12, maxWidth: 120,
                }}
            >
                {conversations.map(c => (
                    <option key={c.id} value={c.id}>{c.title}</option>
                ))}
            </select>
            <button
                onClick={handleNew}
                title="New chat"
                style={{
                    background: 'none', border: '1px solid #555', borderRadius: 4,
                    color: '#aaa', cursor: 'pointer', fontSize: 12, padding: '3px 8px',
                }}
            >
                + New
            </button>
            <button
                onClick={handleDelete}
                title="Delete this chat"
                disabled={!activeId}
                style={{
                    background: 'none', border: '1px solid #663333', borderRadius: 4,
                    color: '#c77', cursor: activeId ? 'pointer' : 'not-allowed',
                    fontSize: 12, padding: '3px 8px', opacity: activeId ? 1 : 0.4,
                }}
            >
                🗑
            </button>
        </div>
    );
}

export default ConversationList;