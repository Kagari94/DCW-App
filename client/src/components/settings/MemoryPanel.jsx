import { useEffect, useState } from 'react';
import { apiJson } from '../../apiConfig';

export default function MemoryPanel() {
    const [facts, setFacts] = useState([]);
    const [error, setError] = useState('');
    const [category, setCategory] = useState('preference');
    const [key, setKey] = useState('');
    const [value, setValue] = useState('');

    async function refresh() {
        try {
            const data = await apiJson('/api/memory/facts');
            setFacts(data.facts);
            setError('');
        } catch (cause) { setError(cause.message); }
    }
    useEffect(() => {
        apiJson('/api/memory/facts')
            .then(data => setFacts(data.facts))
            .catch(cause => setError(cause.message));
    }, []);

    async function add(event) {
        event.preventDefault();
        try {
            await apiJson('/api/memory/facts', {
                method: 'POST', body: JSON.stringify({ category, key, value }),
            });
            setKey('');
            setValue('');
            await refresh();
        } catch (cause) { setError(cause.message); }
    }
    async function update(id, changes) {
        try {
            await apiJson(`/api/memory/facts/${id}`, {
                method: 'PATCH', body: JSON.stringify(changes),
            });
            await refresh();
        } catch (cause) { setError(cause.message); }
    }
    async function forget(id) {
        if (!window.confirm('Forget this fact permanently?')) return;
        try {
            await apiJson(`/api/memory/facts/${id}`, { method: 'DELETE' });
            await refresh();
        } catch (cause) { setError(cause.message); }
    }

    return <details className="memory-panel">
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
                    <button type="submit">Remember</button>
                </div>
            </form>
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
                <div className="memory-actions">
                    <label className="settings-checkbox-row memory-pin">
                        <input type="checkbox" checked={Boolean(fact.pinned)}
                            onChange={event => update(fact.id, { pinned: event.target.checked })} />
                        Pin
                    </label>
                    <button type="submit">Save</button>
                    <button type="button" onClick={() => forget(fact.id)}>Forget</button>
                </div>
            </form>)}
        </div>
    </details>;
}
