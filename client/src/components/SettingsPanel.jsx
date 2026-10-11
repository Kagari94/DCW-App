import { apiJson } from '../apiConfig';
import useSettings from '../hooks/useSettings';
import ProviderSettings from './settings/ProviderSettings';
import { CharacterDisplaySettings } from './settings/CharacterSettings';
import VoiceSettings from './settings/VoiceSettings';
import ServiceSettings from './settings/ServiceSettings';
import MemoryPanel from './settings/MemoryPanel';

export default function SettingsPanel({ onSettingsChange, onOpenCompanion }) {
    const { settings, voices, pocketVoiceFiles, error, setError, saveSetting, uploadVoice } = useSettings(onSettingsChange);
    return <div className="settings-panel">
        {error && <p role="alert">{error}</p>}
        {!settings ? <div className="settings-loading">{error ? 'Could not load settings. Reopen this panel to retry.' : 'Loading settings...'}</div> : <>
            <ProviderSettings settings={settings} saveSetting={saveSetting} />
            <button type="button" onClick={onOpenCompanion}>Model & outfits</button>
            <CharacterDisplaySettings settings={settings} saveSetting={saveSetting} />
            <VoiceSettings settings={settings} voices={voices} pocketVoiceFiles={pocketVoiceFiles}
                saveSetting={saveSetting} uploadVoice={uploadVoice} onError={setError} />
            <ServiceSettings settings={settings} saveSetting={saveSetting} />
            <MemoryPanel />
            <button onClick={() => apiJson('/api/tools/open-config', { method: 'POST' })
                .catch(error => setError(error.message))}>Edit MCP Config</button>
        </>}
    </div>;
}
