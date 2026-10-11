import { useEffect, useRef, useState } from 'react';
import { apiJson } from '../apiConfig';
import useLatestCallback from './useLatestCallback';
import { normalizeCharacterCatalog, normalizeCharacterSettings } from '../utils/characters';

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
    const [supportsProfiles, setSupportsProfiles] = useState(true);
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
                latest.current = normalizeCharacterSettings(data);
                setSettings(latest.current);
                setCharacters(normalizeCharacterCatalog(charactersData.characters));
                setSupportsProfiles(Object.hasOwn(data, 'character'));
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
            const normalized = normalizeCharacterSettings(data);
            if (currentRevision === revision.current) {
                latest.current = normalized;
                setSettings(normalized);
            }
            notify(normalized);
            return normalized;
        }).catch(error => { setError(error.message); return null; });
    }

    async function upload(path, field, file, fields = {}) {
        const body = new FormData();
        body.append(field, file);
        for (const [key, value] of Object.entries(fields)) body.append(key, value);
        return apiJson(path, { method: 'POST', body });
    }
    async function uploadCharacter(file, details = {}) {
        const data = await upload('/api/characters/upload', 'vrm', file, details);
        const list = await apiJson('/api/characters');
        setCharacters(normalizeCharacterCatalog(list.characters));
        if (!await saveSetting({ currentCharacter: data.character?.id || data.filename })) {
            throw new Error('Companion created, but selection failed. Select it in Model.');
        }
    }
    async function createCharacterFromExisting(existingFile, name, personality = '') {
        const result = await apiJson('/api/characters/from-existing', {
            method: 'POST', body: JSON.stringify({ existingFile, name, personality }),
        });
        const list = await apiJson('/api/characters');
        setCharacters(normalizeCharacterCatalog(list.characters));
        if (!await saveSetting({ currentCharacter: result.character.id })) {
            throw new Error('Companion created, but selection failed. Select it in Model.');
        }
    }
    function refreshCharacter(task) {
        const request = saves.current.then(async () => {
            await task();
            const [list, updated] = await Promise.all([apiJson('/api/characters'), apiJson('/api/settings')]);
            setCharacters(normalizeCharacterCatalog(list.characters));
            latest.current = normalizeCharacterSettings(updated);
            setSettings(latest.current);
            notify(latest.current);
            return latest.current;
        });
        saves.current = request.catch(() => {});
        return request;
    }
    function updateCharacter(id, patch) {
        return refreshCharacter(() => apiJson(`/api/characters/${id}`, {
            method: 'PATCH', body: JSON.stringify(patch),
        }));
    }
    function uploadCharacterAnimation(id, file) {
        return refreshCharacter(() => upload(`/api/characters/${id}/animations/upload`, 'animation', file));
    }
    function uploadCharacterImage(id, file) {
        return refreshCharacter(() => upload(`/api/characters/${id}/image`, 'image', file));
    }
    async function uploadVoice(file) {
        const data = await upload('/api/pocket-voices/upload', 'voice', file);
        const list = await apiJson('/api/pocket-voices');
        setPocketVoiceFiles(list.voices || []);
        return data;
    }
    return { settings, characters, supportsProfiles, voices, pocketVoiceFiles, error, setError,
        saveSetting, uploadCharacter, createCharacterFromExisting, updateCharacter,
        uploadCharacterAnimation, uploadCharacterImage, uploadVoice };
}
