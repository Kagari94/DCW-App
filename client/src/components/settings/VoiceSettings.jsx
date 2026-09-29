import { VOICES_BASE } from '../../apiConfig';
import UploadField from './UploadField';

const WHISPER_MODELS = [
    { value: 'Xenova/whisper-tiny.en', label: 'Tiny (fastest, English only)' },
    { value: 'Xenova/whisper-base.en', label: 'Base (balanced, English only)' },
    { value: 'Xenova/whisper-small.en', label: 'Small (more accurate, English only)' },
    { value: 'Xenova/whisper-base', label: 'Base (multilingual)' },
];
function filenameFromVoiceUrl(url) {
    if (!url) return '';
    try {
        const parts = url.split('/');
        return decodeURIComponent(parts[parts.length - 1]);
    } catch {
        return url;
    }
}

export default function VoiceSettings({ settings, voices, pocketVoiceFiles, saveSetting, uploadVoice, onError }) {
    const currentVoiceFilename = filenameFromVoiceUrl(settings.pocketTts?.voice);
    const currentVoiceKnown = pocketVoiceFiles.includes(currentVoiceFilename);
    const saveVoiceInputSetting = patch => saveSetting({ voiceInput: patch });
    async function upload(file) {
        const data = await uploadVoice(file);
        await saveSetting({ pocketTts: { voice: `${VOICES_BASE}/${data.filename}` } });
    }
    return <>
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
                            pocketTts: { baseUrl: e.target.value },
                        })}
                        className="settings-select"
                    />
                    <label className="settings-label settings-label-spaced">Voice</label>
                    <select
                        value={currentVoiceKnown ? currentVoiceFilename : ''}
                        onChange={(e) => {
                            if (!e.target.value) return;
                            const url = `${VOICES_BASE}/${e.target.value}`;
                            saveSetting({ pocketTts: { voice: url } });
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
                                pocketTts: { streaming: e.target.checked },
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
        <UploadField label="Add Voice (Pocket TTS)" accept=".safetensors" onUpload={upload} onError={onError} />
    </>;
}
