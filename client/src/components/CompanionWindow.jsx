import { useState } from 'react';
import useSettings from '../hooks/useSettings';
import DraggableWindow from './DraggableWindow';
import CharacterSettings, { CharacterCreator } from './settings/CharacterSettings';
import OutfitsPanel from './OutfitsPanel';

function ModelPanel({ onSettingsChange }) {
    const model = useSettings(onSettingsChange);
    const [creating, setCreating] = useState(null);
    return <div className="settings-panel">
        {model.error && <p role="alert">{model.error}</p>}
        {!model.settings ? <p>{model.error ? 'Reopen this window to retry.' : 'Loading companions…'}</p> :
            <CharacterSettings {...model} onError={model.setError} onCreate={existing => setCreating({ existing: existing || '' })} />}
        {creating && <DraggableWindow title="Create companion" persistKey="create-companion" width={360}
            initialX={100} initialY={100} onClose={() => setCreating(null)}>
            <div className="settings-panel">
                {model.error && <p role="alert">{model.error}</p>}
                <CharacterCreator {...model} initialModel={creating.existing} onCreated={() => setCreating(null)} onError={model.setError} />
            </div>
        </DraggableWindow>}
    </div>;
}

export default function CompanionWindow({ character, onSettingsChange, onCharacterChange, onClose }) {
    const [tab, setTab] = useState('model');
    const tabs = ['model', 'outfits'];
    return <DraggableWindow title="Companion" persistKey="companion" initialX={window.innerWidth - 440}
        initialY={60} width={400} onClose={onClose}>
        <div role="tablist" aria-label="Companion" className="companion-tabs">
            {tabs.map(id => <button key={id} type="button" role="tab" id={`companion-${id}-tab`}
                aria-controls={`companion-${id}-panel`} aria-selected={tab === id} tabIndex={tab === id ? 0 : -1}
                onClick={() => setTab(id)} onKeyDown={event => {
                    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                    event.preventDefault();
                    const next = event.key === 'Home' ? 'model' : event.key === 'End' ? 'outfits' : tabs.find(item => item !== id);
                    setTab(next);document.getElementById(`companion-${next}-tab`)?.focus();
                }}>{id === 'model' ? 'Model' : 'Outfits'}</button>)}
        </div>
        <section role="tabpanel" id="companion-model-panel" aria-labelledby="companion-model-tab" hidden={tab !== 'model'}>
            <ModelPanel key={character?.id || 'none'} onSettingsChange={onSettingsChange} />
        </section>
        <section role="tabpanel" id="companion-outfits-panel" aria-labelledby="companion-outfits-tab" hidden={tab !== 'outfits'}>
            <OutfitsPanel key={character?.id || 'none'} character={character} onCharacterChange={onCharacterChange} onOpenModels={() => setTab('model')} />
        </section>
    </DraggableWindow>;
}
