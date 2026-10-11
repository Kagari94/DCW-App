import { useRef, useState } from 'react';
import UploadField from './UploadField';
import AppearanceCard from '../AppearanceCard';

function CharacterProfileEditor({ character, updateCharacter, uploadCharacterAnimation, onError }) {
    const [name, setName] = useState(character.name);
    const [personality, setPersonality] = useState(character.personality);
    const changed = name !== character.name || personality !== character.personality;
    return <div className="character-profile-editor">
        <label className="settings-label" htmlFor="companion-name">Companion name</label>
        <input id="companion-name" className="settings-select" maxLength={80} value={name}
            onChange={event => setName(event.target.value)} />
        <label className="settings-label settings-label-spaced" htmlFor="companion-personality">Personality</label>
        <textarea id="companion-personality" className="settings-select" rows={5} maxLength={5000}
            placeholder="How should this companion speak and behave?"
            value={personality} onChange={event => setPersonality(event.target.value)} />
        <button type="button" disabled={!changed || !name.trim()}
            onClick={() => updateCharacter(character.id, { name, personality }).catch(error => onError(error.message))}>
            Save companion
        </button>
        <div className="settings-note">Voice and TTS backend are saved to this companion in Settings.</div>
        <div className="settings-note">Shared animations stay available. Add .vrma or .json files here for this companion.
            A file named wave.vrma becomes the animation “wave”; prefix idle_ or flourish_ for those pools.</div>
        <UploadField label="Add companion animation" accept=".vrma,.json"
            onUpload={file => uploadCharacterAnimation(character.id, file)} onError={onError} />
        {character.animations.length > 0 && <div className="settings-note">
            Extra animations: {character.animations.map(animation => animation.name).join(', ')}
        </div>}
    </div>;
}

export function CharacterCreator({ characters, initialModel = '', uploadCharacter, createCharacterFromExisting, onCreated, onError }) {
    const [newName, setNewName] = useState('');
    const [newPersonality, setNewPersonality] = useState('');
    const [existingModel, setExistingModel] = useState(initialModel);
    const [busy, setBusy] = useState(false);
    const busyRef = useRef(false);
    async function addFromFile(file) {
        if (busyRef.current) return;
        busyRef.current = true; setBusy(true);
        try {
            await uploadCharacter(file, { name: newName.trim(), personality: newPersonality.trim() });
            onCreated();
        } finally { busyRef.current = false; setBusy(false); }
    }
    async function addFromExisting() {
        if (busyRef.current || !existingModel) return;
        busyRef.current = true; setBusy(true);
        try {
            const source = characters.find(character => character.id === existingModel);
            await createCharacterFromExisting(existingModel, newName.trim() || source.name, newPersonality.trim());
            onCreated();
        } catch (error) { onError(error.message); }
        finally { busyRef.current = false; setBusy(false); }
    }
    return <>
        <div className="settings-note">Leave the name blank to use the VRM filename.</div>
        <label className="settings-label" htmlFor="new-companion-name">Name</label>
        <input id="new-companion-name" className="settings-select settings-select-spaced" placeholder="Companion name"
            maxLength={80} value={newName} onChange={event => setNewName(event.target.value)} />
        <label className="settings-label settings-label-spaced" htmlFor="new-companion-personality">Personality</label>
        <textarea id="new-companion-personality" className="settings-select" rows={4} maxLength={5000}
            placeholder="How should this companion speak and behave?"
            value={newPersonality} onChange={event => setNewPersonality(event.target.value)} />
        {characters.some(character => character.legacy) && <div>
            <label className="settings-label" htmlFor="existing-companion-model">Use existing VRM</label>
            <select id="existing-companion-model" className="settings-select" value={existingModel}
                onChange={event => setExistingModel(event.target.value)}>
                <option value="">-- select --</option>
                {characters.filter(character => character.legacy).map(character =>
                    <option key={character.id} value={character.id}>{character.name}</option>)}
            </select>
            <button type="button" disabled={busy || !existingModel} onClick={addFromExisting}>Create companion</button>
        </div>}
        <UploadField label="Add new companion VRM" accept=".vrm" disabled={busy} onUpload={addFromFile} onError={onError} />
    </>;
}

export default function CharacterSettings({ settings, characters, saveSetting, updateCharacter,
    uploadCharacterAnimation, uploadCharacterImage, onCreate, onError, supportsProfiles = true }) {
    const selected = characters.find(character => character.id === settings.currentCharacter) || settings.character;
    return <>
        <div className="appearance-grid">
            {characters.map(character => <AppearanceCard key={character.id}
                name={`${character.name}${character.legacy ? ' (VRM only)' : ''}`} imageUrl={character.imageUrl}
                selected={character.id === settings.currentCharacter} onSelect={() => saveSetting({ currentCharacter: character.id })}
                onUpload={character.legacy || !supportsProfiles ? undefined : file => uploadCharacterImage(character.id, file)} onError={onError} />)}
            {supportsProfiles && <button type="button" className="appearance-add" aria-label="Create companion" onClick={() => onCreate()}>
                <span>+</span><span>Create companion</span>
            </button>}
        </div>
        {!supportsProfiles && <div className="settings-note" role="status">
            Restart the backend to enable saved companion profiles. Existing VRMs can still be selected.
        </div>}
        {supportsProfiles && selected?.legacy && <button type="button" onClick={() => onCreate(selected.id)}>
            Create companion from this VRM
        </button>}
        {supportsProfiles && selected && !selected.legacy && <CharacterProfileEditor key={selected.id} character={selected}
            updateCharacter={updateCharacter} uploadCharacterAnimation={uploadCharacterAnimation} onError={onError} />}
    </>;
}

export function CharacterDisplaySettings({ settings, saveSetting }) {
    return <>
        <div>
            <label className="settings-label">Background Color</label>
            <input type="color" value={settings.backgroundColor || '#1a1a1a'}
                onChange={event => saveSetting({ backgroundColor: event.target.value })}
                className="settings-color-input" />
        </div>
        <div>
            {['key', 'fill', 'rim', 'ambient'].map(lightName => {
                const light = settings.lighting?.[lightName] ?? { color: '#ffffff', intensity: 1 };
                return <div key={lightName} className="settings-light-row">
                    <span className="settings-light-name">{lightName}</span>
                    <input type="color" value={light.color}
                        onChange={event => saveSetting({ lighting: { [lightName]: { color: event.target.value } } })}
                        className="settings-light-swatch" />
                    <input type="range" min="0" max="3" step="0.05" value={light.intensity}
                        onChange={event => saveSetting({ lighting: { [lightName]: { intensity: parseFloat(event.target.value) } } })}
                        className="settings-light-slider" />
                    <span className="settings-light-value">{light.intensity.toFixed(2)}</span>
                </div>;
            })}
        </div>
    </>;
}
