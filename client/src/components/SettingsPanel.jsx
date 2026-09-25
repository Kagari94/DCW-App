import { useState, useEffect, useRef } from 'react';
import { authHeaders } from '../utils/authToken';
import { apiFetch, VOICES_BASE } from '../apiConfig';

const WHISPER_MODELS = [
    { value: 'Xenova/whisper-tiny.en', label: 'Tiny (fastest, English only)' },
    { value: 'Xenova/whisper-base.en', label: 'Base (balanced, English only)' },
    { value: 'Xenova/whisper-small.en', label: 'Small (more accurate, English only)' },
    { value: 'Xenova/whisper-base', label: 'Base (multilingual)' },
];

const PROVIDER_LABELS = {
    lmstudio: 'LM Studio / llama.cpp (local)',
    openai: 'OpenAI',
    custom: 'Custom (OpenAI-compatible)',
};

function filenameFromVoiceUrl(url) {
    if (!url) return '';
    try {
        const parts = url.split('/');
        return decodeURIComponent(parts[parts.length - 1]);
    } catch {
        return url;
    }
}

function SettingsPanel({ onSettingsChange }) {
    const [settings, setSettings] = useState(null);
    const [characters, setCharacters] = useState([]);
    const [uploading, setUploading] = useState(false);
    const [dragOver, setDragOver] = useState(false);
    const [voices, setVoices] = useState([]);
    const [pocketVoiceFiles, setPocketVoiceFiles] = useState([]);
    const [voiceUploading, setVoiceUploading] = useState(false);
    const [voiceDragOver, setVoiceDragOver] = useState(false);
    const fileInputRef = useRef(null);
    const voiceFileInputRef = useRef(null);

    const [llmEditing, setLlmEditing] = useState(false);
    const [llmDraftProvider, setLlmDraftProvider] = useState('lmstudio');
    const [llmDraftProviders, setLlmDraftProviders] = useState({});
    const [llmModelOptions, setLlmModelOptions] = useState([]);
    const [llmModelsLoading, setLlmModelsLoading] = useState(false);
    const [llmModelsError, setLlmModelsError] = useState(null);

    useEffect(() => {
        loadAll();
    }, []);

    async function loadAll() {
        const [settingsRes, charactersRes, voicesRes, pocketVoicesRes] = await Promise.all([
            apiFetch('/api/settings', { headers: authHeaders() }).then(r => r.json()),
            apiFetch('/api/characters', { headers: authHeaders() }).then(r => r.json()),
            apiFetch('/api/voices', { headers: authHeaders() }).then(r => r.json()),
            apiFetch('/api/pocket-voices', { headers: authHeaders() }).then(r => r.json()),
        ]);
        setSettings(settingsRes);
        setCharacters(charactersRes.characters || []);
        setVoices(voicesRes.voices || []);
        setPocketVoiceFiles(pocketVoicesRes.voices || []);
    }

    async function refreshPocketVoices() {
        const data = await apiFetch('/api/pocket-voices', { headers: authHeaders() }).then(r => r.json());
        setPocketVoiceFiles(data.voices || []);
    }

    async function saveSetting(partial) {
        const res = await apiFetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: JSON.stringify(partial),
        });
        const data = await res.json();

        if (!res.ok) {
            throw new Error(data.error || 'Failed to save setting.');
        }

        setSettings(data);
        if (onSettingsChange) onSettingsChange(data);
        return data;
    }

    function saveVoiceInputSetting(partial) {
        saveSetting({
            voiceInput: { ...(settings.voiceInput ?? {}), ...partial },
        });
    }

    async function uploadFile(file) {
        if (!file.name.toLowerCase().endsWith('.vrm')) {
            alert('Only .vrm files are supported.');
            return;
        }
        setUploading(true);
        const formData = new FormData();
        formData.append('vrm', file);

        try {
            const res = await apiFetch('/api/characters/upload', {
                method: 'POST',
                headers: { ...authHeaders() },
                body: formData,
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Upload failed');

            await loadAll();
            await saveSetting({ currentCharacter: data.filename });
        } catch (err) {
            alert(`Upload failed: ${err.message}`);
        } finally {
            setUploading(false);
        }
    }

    function handleDrop(e) {
        e.preventDefault();
        setDragOver(false);
        const file = e.dataTransfer.files?.[0];
        if (file) uploadFile(file);
    }

    async function uploadVoiceFile(file) {
        if (!file.name.toLowerCase().endsWith('.safetensors')) {
            alert('Only .safetensors files are supported.');
            return;
        }
        setVoiceUploading(true);
        const formData = new FormData();
        formData.append('voice', file);

        try {
            const res = await apiFetch('/api/pocket-voices/upload', {
                method: 'POST',
                headers: { ...authHeaders() },
                body: formData,
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Upload failed');

            await refreshPocketVoices();

            const url = `${VOICES_BASE}/${data.filename}`;
            await saveSetting({ pocketTts: { ...(settings.pocketTts ?? {}), voice: url } });
        } catch (err) {
            alert(`Upload failed: ${err.message}`);
        } finally {
            setVoiceUploading(false);
        }
    }

    function handleVoiceDrop(e) {
        e.preventDefault();
        setVoiceDragOver(false);
        const file = e.dataTransfer.files?.[0];
        if (file) uploadVoiceFile(file);
    }

    function fetchModelsFor(providerId, providersObj) {
        setLlmModelsLoading(true);
        setLlmModelsError(null);
        const cfg = providersObj[providerId] || {};
        const params = new URLSearchParams({ provider: providerId });
        if (cfg.baseUrl) params.set('baseUrl', cfg.baseUrl);
        if (cfg.apiKey) params.set('apiKey', cfg.apiKey);

        apiFetch(`/api/models?${params}`, { headers: authHeaders() })
            .then(r => r.json())
            .then(data => {
                setLlmModelOptions(data.models || []);
                setLlmModelsError(data.error || null);
            })
            .catch(err => setLlmModelsError(err.message))
            .finally(() => setLlmModelsLoading(false));
    }

    function startEditingLlm() {
        const provider = settings.llm?.provider || 'lmstudio';
        const providersCopy = JSON.parse(JSON.stringify(settings.llm?.providers || {}));
        setLlmDraftProvider(provider);
        setLlmDraftProviders(providersCopy);
        setLlmEditing(true);
        fetchModelsFor(provider, providersCopy);
    }

    function cancelEditingLlm() {
        setLlmEditing(false);
    }

    function handleDraftProviderChange(newProvider) {
        setLlmDraftProvider(newProvider);
        fetchModelsFor(newProvider, llmDraftProviders);
    }

    function updateDraftField(providerId, field, value) {
        setLlmDraftProviders(prev => ({
            ...prev,
            [providerId]: { ...(prev[providerId] || {}), [field]: value },
        }));
    }

    function refreshModels() {
        fetchModelsFor(llmDraftProvider, llmDraftProviders);
    }

    async function applyLlm() {
        try {
            await saveSetting({
                llm: { provider: llmDraftProvider, providers: llmDraftProviders },
            });
            setLlmEditing(false);
        } catch (err) {
            alert(err.message);
        }
    }

    if (!settings) return <div className="settings-loading">Loading settings...</div>;

    const activeProvider = settings.llm?.provider || 'lmstudio';
    const activeProviderCfg = settings.llm?.providers?.[activeProvider] || {};
    const draftCfg = llmDraftProviders[llmDraftProvider] || {};

    const currentVoiceFilename = filenameFromVoiceUrl(settings.pocketTts?.voice);
    const currentVoiceKnown = pocketVoiceFiles.includes(currentVoiceFilename);

    return (
        <div className="settings-panel">

            <div>
                <label className="settings-label">AI Provider</label>
                {!llmEditing ? (
                    <div className="provider-summary">
                        <div>
                            <strong>{PROVIDER_LABELS[activeProvider] || activeProvider}</strong>
                            <div className="settings-note">{activeProviderCfg.model || '(no model set)'}</div>
                        </div>
                        <button type="button" onClick={startEditingLlm}>Change</button>
                    </div>
                ) : (
                    <div className="provider-edit">
                        <select
                            value={llmDraftProvider}
                            onChange={(e) => handleDraftProviderChange(e.target.value)}
                            className="settings-select"
                        >
                            <option value="lmstudio">LM Studio / llama.cpp (local)</option>
                            <option value="openai">OpenAI</option>
                            <option value="custom">Custom (OpenAI-compatible: DeepSeek, OpenRouter, etc.)</option>
                        </select>

                        {llmDraftProvider !== 'openai' && (
                            <>
                                <label className="settings-label settings-label-spaced">Base URL</label>
                                <input
                                    type="text"
                                    value={draftCfg.baseUrl || ''}
                                    onChange={(e) => updateDraftField(llmDraftProvider, 'baseUrl', e.target.value)}
                                    placeholder={llmDraftProvider === 'lmstudio'
                                        ? 'http://localhost:1234/v1/chat/completions'
                                        : 'e.g. https://api.deepseek.com/v1/chat/completions'}
                                    className="settings-select"
                                />
                            </>
                        )}

                        {llmDraftProvider !== 'lmstudio' && (
                            <>
                                <label className="settings-label settings-label-spaced">API Key</label>
                                <input
                                    type="password"
                                    value={draftCfg.apiKey || ''}
                                    onChange={(e) => updateDraftField(llmDraftProvider, 'apiKey', e.target.value)}
                                    className="settings-select"
                                />
                            </>
                        )}

                        {llmDraftProvider === 'custom' && (
                            <>
                                <label className="settings-label settings-label-spaced">CA Cert Path (optional)</label>
                                <input
                                    type="text"
                                    value={draftCfg.caCertPath || ''}
                                    onChange={(e) => updateDraftField(llmDraftProvider, 'caCertPath', e.target.value)}
                                    placeholder="e.g. server/certs/lan-llm-ca.crt"
                                    className="settings-select"
                                />
                                <div className="settings-note">
                                    Only needed if this endpoint is behind a self-signed TLS proxy (e.g. a
                                    LAN reverse proxy) — pins trust to that one CA cert instead of relying
                                    on the system trust store. Leave blank for a normal public HTTPS
                                    endpoint or a plain local server.
                                </div>
                            </>
                        )}

                        <div className="settings-model-row">
                            <label className="settings-label settings-label-spaced">Model</label>
                            <button type="button" onClick={refreshModels} className="settings-refresh-btn" title="Refresh model list">
                                🔄
                            </button>
                        </div>
                        {llmModelsLoading && <div className="settings-note">Loading models…</div>}
                        {llmModelsError && <div className="settings-note settings-note-error">{llmModelsError}</div>}
                        {llmModelOptions.length > 0 && (
                            <select
                                value=""
                                onChange={(e) => { if (e.target.value) updateDraftField(llmDraftProvider, 'model', e.target.value); }}
                                className="settings-select"
                            >
                                <option value="">-- pick from list --</option>
                                {llmModelOptions.map(m => <option key={m} value={m}>{m}</option>)}
                            </select>
                        )}
                        <input
                            type="text"
                            value={draftCfg.model || ''}
                            onChange={(e) => updateDraftField(llmDraftProvider, 'model', e.target.value)}
                            placeholder="Model name"
                            className="settings-select settings-select-spaced"
                        />
                        {llmDraftProvider === 'openai' && (
                            <div className="settings-note">
                                This list may be out of date — OpenAI ships new models often. Type a
                                model name directly above if what you want isn't listed.
                            </div>
                        )}

                        <div className="settings-provider-actions">
                            <button type="button" onClick={applyLlm}>Apply</button>
                            <button type="button" onClick={cancelEditingLlm}>Cancel</button>
                        </div>
                    </div>
                )}
            </div>

            <div>
                <label className="settings-label">Character (VRM)</label>
                <select
                    value={settings.currentCharacter || ''}
                    onChange={(e) => saveSetting({ currentCharacter: e.target.value })}
                    className="settings-select"
                >
                    <option value="">-- select --</option>
                    {characters.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
            </div>

            <div>
                <label className="settings-label">TTS Backend</label>
                <select
                    value={settings.ttsBackend || 'kokoro'}
                    onChange={(e) => saveSetting({ ttsBackend: e.target.value })}
                    className="settings-select"
                >
                    <option value="kokoro">Kokoro (built-in)</option>
                    <option value="pocket-tts">Pocket TTS (cloned voice)</option>
                </select>
            </div>

            {settings.ttsBackend === 'pocket-tts' ? (
                <div>
                    <label className="settings-label">Pocket TTS Server URL</label>
                    <input
                        type="text"
                        value={settings.pocketTts?.baseUrl || 'http://localhost:8000'}
                        onChange={(e) => saveSetting({
                            pocketTts: { ...(settings.pocketTts ?? {}), baseUrl: e.target.value },
                        })}
                        className="settings-select"
                    />
                    <label className="settings-label settings-label-spaced">Voice</label>
                    <select
                        value={currentVoiceKnown ? currentVoiceFilename : ''}
                        onChange={(e) => {
                            if (!e.target.value) return;
                            const url = `${VOICES_BASE}/${e.target.value}`;
                            saveSetting({ pocketTts: { ...(settings.pocketTts ?? {}), voice: url } });
                        }}
                        className="settings-select"
                    >
                        <option value="">
                            {settings.pocketTts?.voice && !currentVoiceKnown
                                ? `${settings.pocketTts.voice} (custom)`
                                : '-- select a voice --'}
                        </option>
                        {pocketVoiceFiles.map(f => <option key={f} value={f}>{f}</option>)}
                    </select>
                    <div className="settings-note">
                        Leave unselected to use pocket-tts's own default voice. Add new voice files
                        below (under "Add Voice") — export them once with `pocket-tts export-voice`
                        rather than uploading a raw reference clip directly.
                    </div>
                    <label className="settings-checkbox-row settings-checkbox-row-spaced">
                        <input
                            type="checkbox"
                            checked={settings.pocketTts?.streaming ?? false}
                            onChange={(e) => saveSetting({
                                pocketTts: { ...(settings.pocketTts ?? {}), streaming: e.target.checked },
                            })}
                        />
                        Stream audio (lower latency, experimental)
                    </label>
                </div>
            ) : (
                <div>
                    <label className="settings-label">Voice (TTS output)</label>
                    <select
                        value={settings.voice || 'af_bella'}
                        onChange={(e) => saveSetting({ voice: e.target.value })}
                        className="settings-select"
                    >
                        {voices.map(v => <option key={v} value={v}>{v}</option>)}
                    </select>
                </div>
            )}

            <div>
                <label className="settings-label">Voice Input (speech-to-text)</label>
                <label className="settings-checkbox-row settings-checkbox-row-margin">
                    <input
                        type="checkbox"
                        checked={settings.voiceInput?.enabled ?? false}
                        onChange={(e) => saveVoiceInputSetting({ enabled: e.target.checked })}
                    />
                    Enable voice input
                </label>

                {settings.voiceInput?.enabled && (
                    <>
                        <select
                            value={settings.voiceInput?.mode || 'push-to-talk'}
                            onChange={(e) => saveVoiceInputSetting({ mode: e.target.value })}
                            className="settings-select"
                        >
                            <option value="push-to-talk">Push-to-talk (hold mic button)</option>
                            <option value="wake-word">Wake word (always listening)</option>
                        </select>

                        {settings.voiceInput?.mode === 'wake-word' && (
                            <input
                                type="text"
                                value={settings.voiceInput?.wakeWord || ''}
                                onChange={(e) => saveVoiceInputSetting({ wakeWord: e.target.value })}
                                placeholder="Wake word, e.g. hey nova"
                                className="settings-select settings-select-spaced"
                            />
                        )}

                        <label className="settings-label settings-label-spaced">
                            {settings.voiceInput?.mode === 'wake-word'
                                ? 'Command model (used once the wake word is heard)'
                                : 'Transcription model'}
                        </label>
                        <select
                            value={settings.voiceInput?.whisperModel || 'Xenova/whisper-base.en'}
                            onChange={(e) => saveVoiceInputSetting({ whisperModel: e.target.value })}
                            className="settings-select"
                        >
                            {WHISPER_MODELS.map(m => (
                                <option key={m.value} value={m.value}>{m.label}</option>
                            ))}
                        </select>

                        {settings.voiceInput?.mode === 'wake-word' && (
                            <>
                                <label className="settings-label settings-label-spaced">
                                    Wake-word listening model
                                </label>
                                <select
                                    value={settings.voiceInput?.wakeWordPollModel || 'Xenova/whisper-tiny.en'}
                                    onChange={(e) => saveVoiceInputSetting({ wakeWordPollModel: e.target.value })}
                                    className="settings-select"
                                >
                                    {WHISPER_MODELS.map(m => (
                                        <option key={m.value} value={m.value}>{m.label}</option>
                                    ))}
                                </select>
                                <div className="settings-note">
                                    This runs continuously in ~4s background chunks while wake-word
                                    mode is on — Tiny keeps that cost down. Only the command model
                                    above is used for the actual sentence after the wake word.
                                </div>
                            </>
                        )}
                    </>
                )}
            </div>

            <div>
                <label className="settings-label">Camera Gatekeeper (Live Analysis)</label>
                <div className="settings-note">
                    Connection for the background live-camera monitor — a small, separate vision
                    model (not your main chat model) that watches for anything worth escalating.
                    Toggle it on/off from the 📷 button in the chat header; configure where it
                    runs here.
                </div>
                <label className="settings-label settings-label-spaced">Base URL</label>
                <input
                    type="text"
                    value={settings.cameraGatekeeper?.baseUrl || ''}
                    onChange={(e) => saveSetting({
                        cameraGatekeeper: { ...(settings.cameraGatekeeper ?? {}), baseUrl: e.target.value },
                    })}
                    placeholder="e.g. https://192.168.1.145:8444/v1/chat/completions"
                    className="settings-select"
                />
                <label className="settings-label settings-label-spaced">Model</label>
                <input
                    type="text"
                    value={settings.cameraGatekeeper?.model || ''}
                    onChange={(e) => saveSetting({
                        cameraGatekeeper: { ...(settings.cameraGatekeeper ?? {}), model: e.target.value },
                    })}
                    placeholder="e.g. lfm2.5-vl-3b"
                    className="settings-select"
                />
                <label className="settings-label settings-label-spaced">API Key</label>
                <input
                    type="password"
                    value={settings.cameraGatekeeper?.apiKey || ''}
                    onChange={(e) => saveSetting({
                        cameraGatekeeper: { ...(settings.cameraGatekeeper ?? {}), apiKey: e.target.value },
                    })}
                    className="settings-select"
                />
                <label className="settings-label settings-label-spaced">CA Cert Path (optional)</label>
                <input
                    type="text"
                    value={settings.cameraGatekeeper?.caCertPath || ''}
                    onChange={(e) => saveSetting({
                        cameraGatekeeper: { ...(settings.cameraGatekeeper ?? {}), caCertPath: e.target.value },
                    })}
                    placeholder="e.g. certs/lan-llm-ca.crt"
                    className="settings-select"
                />
            </div>

            <div>
                <label className="settings-label">Web Search Provider</label>
                <select
                    value={settings.webSearch?.provider || 'searxng'}
                    onChange={(e) => saveSetting({
                        webSearch: { ...(settings.webSearch ?? {}), provider: e.target.value },
                    })}
                    className="settings-select"
                >
                    <option value="searxng">SearXNG (self-hosted, free, no key)</option>
                    <option value="brave">Brave Search (needs API key + card for signup)</option>
                    <option value="duckduckgo">DuckDuckGo (free, unreliable)</option>
                </select>

                {settings.webSearch?.provider === 'searxng' && (
                    <>
                        <label className="settings-label settings-label-spaced">SearXNG Instance URL</label>
                        <input
                            type="text"
                            value={settings.webSearch?.searxngUrl || 'http://localhost:8888'}
                            onChange={(e) => saveSetting({
                                webSearch: { ...(settings.webSearch ?? {}), searxngUrl: e.target.value },
                            })}
                            className="settings-select"
                        />
                        <div className="settings-note">
                            Requires a running SearXNG instance with JSON output enabled.
                        </div>
                    </>
                )}

                {settings.webSearch?.provider === 'brave' && (
                    <>
                        <label className="settings-label settings-label-spaced">Brave Search API Key</label>
                        <input
                            type="password"
                            value={settings.webSearch?.apiKey || ''}
                            onChange={(e) => saveSetting({
                                webSearch: { ...(settings.webSearch ?? {}), apiKey: e.target.value },
                            })}
                            className="settings-select"
                        />
                    </>
                )}
            </div>

            <div>
                <label className="settings-label">File Access Folder</label>
                <input
                    type="text"
                    value={settings.fileAccess?.rootPath || ''}
                    onChange={(e) => saveSetting({
                        fileAccess: { rootPath: e.target.value },
                    }).catch((err) => alert(err.message))}
                    placeholder="e.g. C:\Users\Kagari\Pictures"
                    className="settings-select"
                />
                <div className="settings-note">
                    The AI can list, rename, and delete (to a recoverable .trash folder) files inside this
                    folder and its subfolders — nowhere else. Paste the full path; browsers can't reveal real
                    folder paths through a picker, so there's no Browse button here. Leave blank to disable
                    file access entirely.
                </div>
            </div>

            <div>
                <label className="settings-label">Background Color</label>
                <input
                    type="color"
                    value={settings.backgroundColor || '#1a1a1a'}
                    onChange={(e) => saveSetting({ backgroundColor: e.target.value })}
                    className="settings-color-input"
                />
            </div>

            <div>
                {['key', 'fill', 'rim', 'ambient'].map((lightName) => {
                    const light = settings.lighting?.[lightName] ?? { color: '#ffffff', intensity: 1 };
                    return (
                        <div key={lightName} className="settings-light-row">
                            <span className="settings-light-name">{lightName}</span>
                            <input
                                type="color"
                                value={light.color}
                                onChange={(e) => saveSetting({
                                    lighting: {
                                        ...(settings.lighting ?? {}),
                                        [lightName]: { ...light, color: e.target.value },
                                    },
                                })}
                                className="settings-light-swatch"
                            />
                            <input
                                type="range"
                                min="0"
                                max="3"
                                step="0.05"
                                value={light.intensity}
                                onChange={(e) => saveSetting({
                                    lighting: {
                                        ...(settings.lighting ?? {}),
                                        [lightName]: { ...light, intensity: parseFloat(e.target.value) },
                                    },
                                })}
                                className="settings-light-slider"
                            />
                            <span className="settings-light-value">{light.intensity.toFixed(2)}</span>
                        </div>
                    );
                })}
                <button onClick={async () => {
                    const res = await apiFetch('/api/tools/open-config', {
                        method: 'POST',
                        headers: authHeaders(),
                    });
                    if (!res.ok) alert((await res.json()).error);
                }}>
                    Edit MCP Config
                </button>
            </div>

            <div>
                <label className="settings-label">Add New Character</label>
                <div
                    onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                    onDragLeave={() => setDragOver(false)}
                    onDrop={handleDrop}
                    onClick={() => fileInputRef.current?.click()}
                    className={`settings-dropzone${dragOver ? ' dragging' : ''}`}
                >
                    {uploading ? 'Uploading...' : 'Drag & drop a .vrm file here, or click to browse'}
                </div>
                <input
                    ref={fileInputRef}
                    type="file"
                    accept=".vrm"
                    className="hidden-input"
                    onChange={(e) => e.target.files?.[0] && uploadFile(e.target.files[0])}
                />
            </div>

            <div>
                <label className="settings-label">Add Voice (Pocket TTS)</label>
                <div
                    onDragOver={(e) => { e.preventDefault(); setVoiceDragOver(true); }}
                    onDragLeave={() => setVoiceDragOver(false)}
                    onDrop={handleVoiceDrop}
                    onClick={() => voiceFileInputRef.current?.click()}
                    className={`settings-dropzone${voiceDragOver ? ' dragging' : ''}`}
                >
                    {voiceUploading ? 'Uploading...' : 'Drag & drop a .safetensors voice file here, or click to browse'}
                </div>
                <input
                    ref={voiceFileInputRef}
                    type="file"
                    accept=".safetensors"
                    className="hidden-input"
                    onChange={(e) => e.target.files?.[0] && uploadVoiceFile(e.target.files[0])}
                />
            </div>
        </div>
    );
}

export default SettingsPanel;