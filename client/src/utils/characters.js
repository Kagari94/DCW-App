function legacyCharacter(filename) {
    if (typeof filename !== 'string' || !filename.toLowerCase().endsWith('.vrm')) return null;
    return {
        id: filename,
        name: filename.replace(/\.vrm$/i, ''),
        modelName: filename,
        modelUrl: `/models/characters/${encodeURIComponent(filename)}`,
        personality: '',
        animations: [],
        legacy: true,
    };
}

// Older running backends return VRM filenames and omit settings.character.
// Keep existing models usable while the backend is being restarted.
export function normalizeCharacterCatalog(characters = []) {
    return (Array.isArray(characters) ? characters : [])
        .map(item => typeof item === 'string' ? legacyCharacter(item) : item).filter(Boolean);
}

export function normalizeCharacterSettings(settings) {
    if (!settings || Object.hasOwn(settings, 'character')) return settings;
    const character = legacyCharacter(settings.currentCharacter);
    return character ? { ...settings, character } : settings;
}

// An outfit refresh may complete after the user has selected another companion.
export function applyCharacterUpdate(settings, character) {
    return settings?.currentCharacter === character?.id ? { ...settings, character } : settings;
}
