import { apiJson } from '../apiConfig';
import useSettings from '../hooks/useSettings';
import ProviderSettings from './settings/ProviderSettings';
import CharacterSettings from './settings/CharacterSettings';
import VoiceSettings from './settings/VoiceSettings';
import ServiceSettings from './settings/ServiceSettings';
import MemoryPanel from './settings/MemoryPanel';

export default function SettingsPanel({ onSettingsChange }) {
    const { settings, characters, voices, pocketVoiceFiles, error, setError,
        saveSetting, uploadCharacter, uploadVoice } = useSettings(onSettingsChange);
    return <div className="settings-panel">
        {error && <p role="alert">{error}</p>}
        {!settings ? <div className="settings-loading">{error ? 'Could not load settings. Reopen this panel to retry.' : 'Loading settings...'}</div> : <>
            <ProviderSettings settings={settings} saveSetting={saveSetting} />
            <CharacterSettings settings={settings} characters={characters} saveSetting={saveSetting}
                uploadCharacter={uploadCharacter} onError={setError} />
            <VoiceSettings settings={settings} voices={voices} pocketVoiceFiles={pocketVoiceFiles}
                saveSetting={saveSetting} uploadVoice={uploadVoice} onError={setError} />
            <ServiceSettings settings={settings} saveSetting={saveSetting} />
            <MemoryPanel />
            <button onClick={() => apiJson('/api/tools/open-config', { method: 'POST' })
                .catch(error => setError(error.message))}>Edit MCP Config</button>
        </>}
    </div>;
}
