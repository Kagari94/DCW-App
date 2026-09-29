import UploadField from './UploadField';

export default function CharacterSettings({ settings, characters, saveSetting, uploadCharacter, onError }) {
    return <>
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
                                        [lightName]: { color: e.target.value },
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
                                        [lightName]: { intensity: parseFloat(e.target.value) },
                                    },
                                })}
                                className="settings-light-slider"
                            />
                            <span className="settings-light-value">{light.intensity.toFixed(2)}</span>
                        </div>
                    );
                })}
            </div>
        <UploadField label="Add New Character" accept=".vrm" onUpload={uploadCharacter} onError={onError} />
    </>;
}
