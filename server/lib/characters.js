const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const CHARACTERS_DIR = path.join(__dirname, '../../client/public/models/characters');
const VOICES_DIR = path.join(__dirname, '../data/voices');
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const animationFile = name => /^[^/\\]+\.(?:vrma|json)$/i.test(name) && name !== '.' && name !== '..';
const modelFile = name => typeof name === 'string' && path.basename(name) === name && name.toLowerCase().endsWith('.vrm');
const modelUrl = name => `/models/characters/${name.split('/').map(encodeURIComponent).join('/')}`;

function badRequest(message) { throw Object.assign(new Error(message), { status: 400 }); }
function createCharacterStore({ charactersDir = CHARACTERS_DIR, voicesDir = VOICES_DIR } = {}) {
    function directoryFor(id) {
        if (!ID_PATTERN.test(id)) badRequest('Invalid character ID.');
        return path.join(charactersDir, id);
    }
    function animationName(filename) {
        return path.parse(filename).name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '');
    }

    function outfitDirectoryFor(id, outfitId) {
        if (outfitId !== 'default' && !ID_PATTERN.test(outfitId || '')) badRequest('Invalid outfit ID.');
        return path.join(directoryFor(id), 'outfits', outfitId);
    }

    function readManifest(id) {
        return JSON.parse(fs.readFileSync(path.join(directoryFor(id), 'character.json'), 'utf8'));
    }

    function manifestOutfits(manifest) {
        const outfits = manifest.outfits || [{ id: 'default', name: 'Default' }];
        if (!Array.isArray(outfits) || !outfits.some(outfit => outfit?.id === 'default')) badRequest('Invalid outfit list.');
        const ids = new Set();
        for (const outfit of outfits) {
            if (!outfit || (outfit.id !== 'default' && !ID_PATTERN.test(outfit.id || '')) || ids.has(outfit.id) ||
                typeof outfit.name !== 'string' || !outfit.name.trim() || outfit.name.length > 80 ||
                (outfit.image && outfit.image !== 'preview.webp') ||
                (outfit.imageRevision && !ID_PATTERN.test(outfit.imageRevision)) ||
                (outfit.originalName && !modelFile(outfit.originalName))) badRequest('Invalid outfit details.');
            ids.add(outfit.id);
        }
        return outfits;
    }

    function readCharacter(id) {
        if (ID_PATTERN.test(id || '')) {
            const directory = directoryFor(id);
            const manifest = readManifest(id);
            if (manifest.version !== 1 || manifest.id !== id ||
                !['model.vrm', null].includes(manifest.model)) throw new Error(`Invalid character manifest: ${id}`);
            validateProfile(manifest);
            if ((manifest.image && manifest.image !== 'preview.webp') ||
                (manifest.imageRevision && !ID_PATTERN.test(manifest.imageRevision))) badRequest('Invalid companion image.');
            const originalFilename = manifest.legacyFile || `${id}/model.vrm`;
            if (!fs.existsSync(path.join(charactersDir, originalFilename))) throw new Error(`Character model missing: ${id}`);
            const outfits = manifestOutfits(manifest).map(outfit => {
                const filename = outfit.id === 'default' ? originalFilename : `${id}/outfits/${outfit.id}/model.vrm`;
                const imagePath = path.join(outfitDirectoryFor(id, outfit.id), 'preview.webp');
                return { id: outfit.id, name: outfit.name, modelUrl: modelUrl(filename),
                    modelName: outfit.originalName || (outfit.id === 'default' ? manifest.legacyFile || 'model.vrm' : 'model.vrm'),
                    available: fs.existsSync(path.join(charactersDir, filename)),
                    imageUrl: outfit.image && fs.existsSync(imagePath)
                        ? `${modelUrl(id)}/outfits/${outfit.id}/preview.webp?v=${outfit.imageRevision || '1'}` : null };
            });
            // A removed outfit file must not make the whole companion disappear.
            const active = outfits.find(outfit => outfit.id === manifest.activeOutfit && outfit.available) || outfits.find(outfit => outfit.id === 'default');
            const animationDirectory = path.join(directory, 'animations');
            const animations = fs.existsSync(animationDirectory)
                ? fs.readdirSync(animationDirectory).filter(animationFile).sort().map(file => ({
                    name: animationName(file),
                    url: `${modelUrl(id)}/animations/${encodeURIComponent(file)}`,
                })).filter(entry => entry.name)
                : [];
            return {
                id, name: manifest.name, personality: manifest.personality || '',
                imageUrl: manifest.image && fs.existsSync(path.join(directory, 'preview.webp'))
                    ? `${modelUrl(id)}/preview.webp?v=${manifest.imageRevision || '1'}` : null,
                voice: manifest.voice || null, modelName: active.modelName,
                modelUrl: active.modelUrl, outfits, activeOutfit: active.id, animations, legacy: false,
            };
        }
        if (!modelFile(id) || !fs.existsSync(path.join(charactersDir, id))) return null;
        return { id, name: path.parse(id).name, personality: '', voice: null,
            modelName: id, modelUrl: modelUrl(id), animations: [], legacy: true };
    }

    function listCharacters() {
        if (!fs.existsSync(charactersDir)) return [];
        const entries = fs.readdirSync(charactersDir, { withFileTypes: true });
        const characters = [];
        for (const entry of entries) {
            if (!((entry.isDirectory() && ID_PATTERN.test(entry.name)) || (entry.isFile() && modelFile(entry.name)))) continue;
            try { characters.push(readCharacter(entry.name)); }
            catch (error) { console.warn(`Skipping invalid character ${entry.name}: ${error.message}`); }
        }
        return characters.filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
    }

    function validateProfile({ name, personality = '', voice = {}, legacyFile = null, model = null }) {
        if (typeof name !== 'string' || !name.trim() || name.length > 80) badRequest('Character name must be 1–80 characters.');
        if (typeof personality !== 'string' || personality.length > 5000) badRequest('Personality must be at most 5000 characters.');
        if (legacyFile && (!modelFile(legacyFile) || !fs.existsSync(path.join(charactersDir, legacyFile)))) badRequest('Existing VRM not found.');
        if (!legacyFile && model !== 'model.vrm') badRequest('Character model is missing.');
        if (!voice || typeof voice !== 'object' || !['kokoro', 'pocket-tts'].includes(voice.backend) ||
            typeof voice.kokoro !== 'string' || typeof voice.pocket !== 'string') badRequest('Invalid character voice.');
        return { name: name.trim(), personality: personality.trim(), voice, legacyFile, model };
    }

    function writeManifest(id, manifest) {
        const directory = directoryFor(id);
        const destination = path.join(directory, 'character.json');
        const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
        fs.mkdirSync(directory, { recursive: true });
        try {
            fs.writeFileSync(temporary, JSON.stringify(manifest, null, 2), { flag: 'wx' });
            fs.renameSync(temporary, destination);
        } finally { fs.rmSync(temporary, { force: true }); }
        return readCharacter(id);
    }

    function createCharacter({ name, personality = '', voice, legacyFile = null, model = null, id = crypto.randomUUID() }) {
        const manifest = { version: 1, id, ...validateProfile({ name, personality, voice, legacyFile, model }) };
        if (!legacyFile && !fs.existsSync(path.join(directoryFor(id), 'model.vrm'))) badRequest('Uploaded VRM is missing.');
        return writeManifest(id, manifest);
    }

    function updateCharacter(id, patch) {
        const manifest = readManifest(id);
        const updated = { ...manifest,
            ...(patch.name !== undefined && { name: patch.name }),
            ...(patch.personality !== undefined && { personality: patch.personality }),
            ...(patch.voice !== undefined && { voice: { ...manifest.voice, ...patch.voice } }),
        };
        return writeManifest(id, { ...updated, ...validateProfile(updated) });
    }

    function getOutfit(id, outfitId) {
        const outfit = readCharacter(id)?.outfits?.find(item => item.id === outfitId);
        if (!outfit) badRequest('Outfit not found.');
        return outfit;
    }

    function addOutfit(id, { name, outfitId = crypto.randomUUID(), originalName }) {
        if (outfitId === 'default') badRequest('The default outfit already exists.');
        const manifest = readManifest(id);
        const outfits = manifestOutfits(manifest);
        if (outfits.some(outfit => outfit.id === outfitId)) badRequest('Outfit already exists.');
        if (!fs.existsSync(path.join(outfitDirectoryFor(id, outfitId), 'model.vrm'))) badRequest('Uploaded outfit model is missing.');
        const updated = { ...manifest, outfits: [...outfits, { id: outfitId, name: typeof name === 'string' ? name.trim() : name, originalName }] };
        manifestOutfits(updated);
        return writeManifest(id, updated);
    }

    function updateOutfit(id, outfitId, patch) {
        getOutfit(id, outfitId);
        const manifest = readManifest(id);
        const updated = { ...manifest, outfits: manifestOutfits(manifest).map(outfit => outfit.id === outfitId
            ? { ...outfit, ...(patch.name !== undefined && { name: typeof patch.name === 'string' ? patch.name.trim() : patch.name }),
                ...(patch.image !== undefined && { image: patch.image, imageRevision: patch.imageRevision }) } : outfit) };
        manifestOutfits(updated);
        return writeManifest(id, updated);
    }

    function selectOutfit(id, outfitId) {
        if (!getOutfit(id, outfitId).available) badRequest('Outfit model is missing.');
        return writeManifest(id, { ...readManifest(id), activeOutfit: outfitId });
    }

    function updateCharacterImage(id, imageRevision) {
        return writeManifest(id, { ...readManifest(id), image: 'preview.webp', imageRevision });
    }

    function voiceFromSettings(settings) {
        return { backend: settings.ttsBackend || 'kokoro', kokoro: settings.voice || 'af_bella',
            pocket: settings.pocketTts?.voice || '' };
    }

    function profileVoiceSettings(settings, character) {
        if (!character?.voice) return settings;
        const pocket = character.voice.pocket || '';
        const base = process.env.COMPANION_VOICE_BASE_URL || `http://127.0.0.1:${process.env.PORT || 3000}/voices`;
        const url = pocket && !pocket.includes('://') && fs.existsSync(path.join(voicesDir, pocket))
            ? `${base.replace(/\/$/, '')}/${encodeURIComponent(pocket)}` : pocket;
        return { ...settings, ttsBackend: character.voice.backend, voice: character.voice.kokoro,
            pocketTts: { ...settings.pocketTts, voice: url } };
    }

    return { directoryFor, outfitDirectoryFor, readCharacter, listCharacters, createCharacter, updateCharacter,
        getOutfit, addOutfit, updateOutfit, selectOutfit, updateCharacterImage,
        voiceFromSettings, profileVoiceSettings };
}

module.exports = { CHARACTERS_DIR, animationFile, createCharacterStore, ...createCharacterStore() };
