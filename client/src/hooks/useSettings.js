import { useEffect, useRef, useState } from 'react';
import { apiJson } from '../apiConfig';
import useLatestCallback from './useLatestCallback';

function mergeSettings(current, patch) {
    const result = { ...current };
    for (const [key, value] of Object.entries(patch)) {
        result[key] = value && typeof value === 'object' && !Array.isArray(value)
            ? mergeSettings(current?.[key], value) : value;
    }
    return result;
}

export default function useSettings(onSettingsChange) {
    const [settings, setSettings] = useState(null);
    const [characters, setCharacters] = useState([]);
    const [voices, setVoices] = useState([]);
    const [pocketVoiceFiles, setPocketVoiceFiles] = useState([]);
    const [error, setError] = useState(null);
    const latest = useRef(null);
    const revision = useRef(0);
    const saves = useRef(Promise.resolve());
    const notify = useLatestCallback(onSettingsChange);

    useEffect(() => {
        const controller = new AbortController();
        const options = { signal: controller.signal };
        Promise.all(['/api/settings', '/api/characters', '/api/voices', '/api/pocket-voices']
            .map(path => apiJson(path, options)))
            .then(([data, charactersData, voicesData, pocketData]) => {
                if (controller.signal.aborted) return;
                latest.current = data;
                setSettings(data);
                setCharacters(charactersData.characters || []);
                setVoices(voicesData.voices || []);
                setPocketVoiceFiles(pocketData.voices || []);
            }).catch(error => { if (!controller.signal.aborted) setError(error.message); });
        return () => controller.abort();
    }, []);

    // Queue writes and merge field patches against the latest draft so quick edits
    // cannot overwrite sibling fields or roll controls back to an old response.
    function saveSetting(patch) {
        const currentRevision = ++revision.current;
        const draft = mergeSettings(latest.current, patch);
        latest.current = draft;
        setSettings(draft);
        setError(null);
        const body = JSON.stringify(Object.fromEntries(Object.keys(patch).map(key => [key, draft[key]])));
        const request = saves.current.then(() => apiJson('/api/settings', { method: 'POST', body }));
        saves.current = request.catch(() => {});
        return request.then(data => {
            if (currentRevision === revision.current) {
                latest.current = data;
                setSettings(data);
            }
            notify(data);
            return data;
        }).catch(error => { setError(error.message); return null; });
    }

    async function upload(path, field, file) {
        const body = new FormData();
        body.append(field, file);
        return apiJson(path, { method: 'POST', body });
    }
    async function uploadCharacter(file) {
        const data = await upload('/api/characters/upload', 'vrm', file);
        const list = await apiJson('/api/characters');
        setCharacters(list.characters || []);
        await saveSetting({ currentCharacter: data.filename });
    }
    async function uploadVoice(file) {
        const data = await upload('/api/pocket-voices/upload', 'voice', file);
        const list = await apiJson('/api/pocket-voices');
        setPocketVoiceFiles(list.voices || []);
        return data;
    }
    return { settings, characters, voices, pocketVoiceFiles, error, setError,
        saveSetting, uploadCharacter, uploadVoice };
}
