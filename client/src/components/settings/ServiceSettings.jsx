import SettingsField from './SettingsField';

const CAMERA_FIELDS = [
    ['baseUrl', 'Base URL', 'text'], ['model', 'Model', 'text'],
    ['apiKey', 'API Key', 'password'], ['caCertPath', 'CA Cert Path (optional)', 'text'],
];
export default function ServiceSettings({ settings, saveSetting }) {
    return <>
        <div>
            <label className="settings-label">Camera Gatekeeper (Live Analysis)</label>
            <p className="settings-note">Connection for the background live-camera monitor. Toggle it from the camera button in chat.</p>
            {CAMERA_FIELDS.map(([key, label, type]) => <SettingsField key={key} label={label} type={type}
                value={settings.cameraGatekeeper?.[key] || ''}
                onChange={event => saveSetting({ cameraGatekeeper: { [key]: event.target.value } })} />)}
        </div>
            <div>
                <label className="settings-label">Web Search Provider</label>
                <select
                    value={settings.webSearch?.provider || 'searxng'}
                    onChange={(e) => saveSetting({
                        webSearch: { provider: e.target.value },
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
                                webSearch: { searxngUrl: e.target.value },
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
                                webSearch: { apiKey: e.target.value },
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
                    })}
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
    </>;
}
