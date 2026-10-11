import { useEffect, useState } from 'react';
import { apiJson } from '../../apiConfig';

function MemoryHistory({ id }) {
    const [history, setHistory] = useState(null);
    const [error, setError] = useState('');
    return <details className="memory-history" onToggle={async event => {
        if (!event.currentTarget.open) return;
        try { setHistory(await apiJson(`/api/memory/facts/${id}/history`)); setError(''); }
        catch (cause) { setError(cause.message); }
    }}>
        <summary>History</summary>
        {error && <p role="alert">{error}</p>}
        {!history && !error && <p>Loading…</p>}
        {history && <>
            {history.revisions.length === 0 && history.proposals.length === 0 && history.originals.length === 0 &&
                <p>No previous changes.</p>}
            {history.revisions.map(row => <p key={`revision-${row.id}`}>Previous: {row.value}</p>)}
            {history.proposals.map(row => <p key={`proposal-${row.id}`}>{row.status}: {row.value}</p>)}
            {history.originals.map((row, index) => <p key={index}>Merged: {JSON.parse(row.original_fact).value}</p>)}
        </>}
    </details>;
}

export default function MemoryPanel() {
    const [facts, setFacts] = useState([]);
    const [proposals, setProposals] = useState([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [category, setCategory] = useState('preference');
    const [key, setKey] = useState('');
    const [value, setValue] = useState('');

    async function refresh() {
        try {
            const data = await apiJson('/api/memory/facts');
            setFacts(data.facts);
            setProposals(data.proposals || []);
            setError('');
        } catch (cause) { setError(cause.message); }
    }
    useEffect(() => {
        apiJson('/api/memory/facts')
            .then(data => { setFacts(data.facts); setProposals(data.proposals || []); })
            .catch(cause => setError(cause.message));
    }, []);

    async function add(event) {
        event.preventDefault();
        setBusy(true);
        try {
            await apiJson('/api/memory/facts', {
                method: 'POST', body: JSON.stringify({ category, key, value }),
            });
            setKey('');
            setValue('');
            await refresh();
        } catch (cause) { setError(cause.message); }
        finally { setBusy(false); }
    }
    async function update(id, changes) {
        setBusy(true);
        try {
            await apiJson(`/api/memory/facts/${id}`, {
                method: 'PATCH', body: JSON.stringify(changes),
            });
            await refresh();
        } catch (cause) { setError(cause.message); }
        finally { setBusy(false); }
    }
    async function forget(id) {
        if (!window.confirm('Forget this memory permanently and reset past-conversation recall? Saved chats remain.')) return;
        setBusy(true);
        try {
            await apiJson(`/api/memory/facts/${id}`, { method: 'DELETE' });
            await refresh();
        } catch (cause) { setError(cause.message); }
        finally { setBusy(false); }
    }
    async function review(id, action) {
        setBusy(true);
        try {
            await apiJson(`/api/memory/proposals/${id}/${action}`, { method: 'POST' });
            await refresh();
        } catch (cause) { setError(cause.message); }
        finally { setBusy(false); }
    }

    return <details className="memory-panel" onToggle={event => {
        if (event.target === event.currentTarget && event.currentTarget.open) refresh();
    }}>
        <summary>User memory</summary>
        <div className="memory-panel-content">
            <p className="settings-note">These facts stay in your companion's memory when chats are deleted. Only Forget removes one.</p>
            {error && <p className="settings-note settings-note-error" role="alert">{error}</p>}
            <form className="memory-form" onSubmit={add}>
                <label className="memory-field">
                    <span className="settings-label">Type</span>
                    <select className="settings-select" value={category} onChange={event => setCategory(event.target.value)}>
                        {['identity', 'preference', 'want', 'need', 'project', 'other'].map(item =>
                            <option key={item} value={item}>{item}</option>)}
                    </select>
                </label>
                <label className="memory-field">
                    <span className="settings-label">Topic</span>
                    <input className="settings-select" value={key} onChange={event => setKey(event.target.value)} required maxLength={80} />
                </label>
                <label className="memory-field">
                    <span className="settings-label">What to remember</span>
                    <textarea className="settings-select memory-value" rows={3}
                        value={value} onChange={event => setValue(event.target.value)} required maxLength={600} />
                </label>
                <div className="memory-actions">
                    <button type="submit" disabled={busy}>Remember</button>
                </div>
            </form>
            {proposals.length > 0 && <div className="memory-proposals">
                <p>Suggested changes</p>
                {proposals.map(proposal => <div className="memory-form" key={proposal.id}>
                    <span className="settings-label">{proposal.category}: {proposal.key}</span>
                    <p>Saved: {proposal.current_value}</p>
                    <p>Suggested: {proposal.value}</p>
                    {proposal.source_quote && <blockquote>{proposal.source_quote}</blockquote>}
                    <div className="memory-actions">
                        <button type="button" disabled={busy} onClick={() => review(proposal.id, 'accept')}>Accept</button>
                        <button type="button" disabled={busy} onClick={() => review(proposal.id, 'dismiss')}>Dismiss</button>
                    </div>
                </div>)}
            </div>}
            {facts.length === 0 && <p className="settings-note">No saved facts yet.</p>}
            {facts.map(fact => <form className="memory-form" key={fact.id} onSubmit={event => {
                event.preventDefault();
                update(fact.id, { value: event.currentTarget.elements.factValue.value });
            }}>
                <label className="memory-field">
                    <span className="settings-label">{fact.category}: {fact.key}</span>
                    <textarea className="settings-select memory-value" name="factValue" rows={3}
                        defaultValue={fact.value} key={fact.value} maxLength={600} required />
                </label>
                <p className="memory-source">{fact.source_kind === 'manual' ? 'Confirmed by you' : 'From conversation'}
                    {fact.source_conversation_id && <span title={fact.source_conversation_id}> · {fact.source_conversation_id.slice(0, 8)}</span>}
                </p>
                {fact.source_quote && <blockquote>{fact.source_quote}</blockquote>}
                <MemoryHistory id={fact.id} />
                <div className="memory-actions">
                    <label className="settings-checkbox-row memory-pin">
                        <input type="checkbox" checked={Boolean(fact.pinned)}
                            disabled={busy}
                            onChange={event => update(fact.id, { pinned: event.target.checked })} />
                        Pin
                    </label>
                    <button type="submit" disabled={busy}>Save</button>
                    <button type="button" disabled={busy} onClick={() => forget(fact.id)}>Forget</button>
                </div>
            </form>)}
        </div>
    </details>;
}
