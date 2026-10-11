import { useRef, useState } from 'react';
import { apiJson } from '../apiConfig';
import AppearanceCard from './AppearanceCard';
import UploadField from './settings/UploadField';

export default function OutfitsPanel({ character, onCharacterChange, onOpenModels }) {
    const [name, setName] = useState('');
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);
    const busyRef = useRef(false);
    if (!character || character.legacy) return <div className="settings-panel">
        <p>Create a saved companion to add outfits.</p><button type="button" onClick={onOpenModels}>Open Model</button>
    </div>;
    if (!character.outfits) return <p className="settings-loading">Restart the backend to enable outfits.</p>;
    const base = `/api/characters/${encodeURIComponent(character.id)}/outfits`;
    async function perform(task) {
        if (busyRef.current) return false;
        busyRef.current = true; setBusy(true); setError(null);
        try {
            const data = await task();
            onCharacterChange(data.character);
            return true;
        } catch (error) { setError(error.message); return false; }
        finally { busyRef.current = false; setBusy(false); }
    }
    async function upload(path, field, file, fields = {}) {
        const body = new FormData(); body.append(field, file);
        for (const [key, value] of Object.entries(fields)) body.append(key, value);
        return perform(() => apiJson(path, { method: 'POST', body }));
    }
    return <div className="settings-panel">
        {error && <p role="alert">{error}</p>}
        <div className="appearance-grid">
            {character.outfits.map(outfit => <AppearanceCard key={outfit.id} name={outfit.name} imageUrl={outfit.imageUrl}
                selected={outfit.id === character.activeOutfit} disabled={busy || !outfit.available}
                onSelect={() => perform(() => apiJson(`${base}/${outfit.id}/select`, { method: 'POST' }))}
                onUpload={file => upload(`${base}/${outfit.id}/image`, 'image', file)} onError={setError} />)}
        </div>
        {character.outfits.some(outfit => !outfit.available) && <p className="settings-note">Some outfit model files are missing.</p>}
        <label className="settings-label" htmlFor="new-outfit-name">Outfit name</label>
        <input id="new-outfit-name" className="settings-select" value={name} maxLength={80}
            placeholder="Casual, winter, formal…" onChange={event => setName(event.target.value)} />
        <UploadField label="Add outfit VRM" accept=".vrm" disabled={busy} onError={setError}
            onUpload={async file => { if (await upload(`${base}/upload`, 'vrm', file, { name: name.trim() })) setName(''); }} />
    </div>;
}
