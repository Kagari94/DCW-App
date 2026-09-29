import { useState } from 'react';
import { apiJson } from '../../apiConfig';

const PROVIDER_LABELS = {
    lmstudio: 'LM Studio / llama.cpp (local)',
    openai: 'OpenAI',
    custom: 'Custom (OpenAI-compatible)',
};

export default function ProviderSettings({ settings, saveSetting }) {
    const [llmEditing, setLlmEditing] = useState(false);
    const [llmDraftProvider, setLlmDraftProvider] = useState('lmstudio');
    const [llmDraftProviders, setLlmDraftProviders] = useState({});
    const [llmModelOptions, setLlmModelOptions] = useState([]);
    const [llmModelsLoading, setLlmModelsLoading] = useState(false);
    const [llmModelsError, setLlmModelsError] = useState(null);
    function fetchModelsFor(providerId, providersObj) {
        setLlmModelsLoading(true);
        setLlmModelsError(null);
        const cfg = providersObj[providerId] || {};
        const params = new URLSearchParams({ provider: providerId });
        if (cfg.baseUrl) params.set('baseUrl', cfg.baseUrl);
        if (cfg.apiKey) params.set('apiKey', cfg.apiKey);

        apiJson(`/api/models?${params}`)
            .then(data => {
                setLlmModelOptions(data.models || []);
                setLlmModelsError(data.error || null);
            })
            .catch(err => setLlmModelsError(err.message))
            .finally(() => setLlmModelsLoading(false));
    }

    function startEditingLlm() {
        const provider = settings.llm?.provider || 'lmstudio';
        const providersCopy = structuredClone(settings.llm?.providers || {});
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
            const saved = await saveSetting({
                llm: { provider: llmDraftProvider, providers: llmDraftProviders },
            });
            if (saved) setLlmEditing(false);
        } catch (err) {
            alert(err.message);
        }
    }
    const activeProvider = settings.llm?.provider || 'lmstudio';
    const activeProviderCfg = settings.llm?.providers?.[activeProvider] || {};
    const draftCfg = llmDraftProviders[llmDraftProvider] || {};

    return (
            <div>
                <label className="settings-label">AI Provider</label>
                {!llmEditing ? (
                    <div className="provider-summary">
                        <div className="provider-summary-details">
                            <strong>{PROVIDER_LABELS[activeProvider] || activeProvider}</strong>
                            <div className="settings-note" title={activeProviderCfg.model}>
                                {activeProviderCfg.model || '(no model set)'}
                            </div>
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

    );
}
