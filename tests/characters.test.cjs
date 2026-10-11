const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createCharacterStore } = require('../server/lib/characters');
const { createSettingsStore } = require('../server/settings');
const { withCharacterContext } = require('../server/lib/toolCallLoop');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-characters-test-'));
    const charactersDir = path.join(root, 'characters');
    const voicesDir = path.join(root, 'voices');
    fs.mkdirSync(charactersDir);
    fs.mkdirSync(voicesDir);
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return { root, charactersDir, voicesDir,
        store: createCharacterStore({ charactersDir, voicesDir }) };
}

const voice = { backend: 'pocket-tts', kokoro: 'af_nova', pocket: 'Hsin.safetensors' };

test('existing VRMs get separate persistent profiles without moving the model or voice', t => {
    const { charactersDir, voicesDir, store } = fixture(t);
    fs.writeFileSync(path.join(charactersDir, 'Hsin Default.vrm'), 'model');
    fs.writeFileSync(path.join(voicesDir, 'Hsin.safetensors'), 'voice');
    const first = store.createCharacter({ name: 'Hsin', personality: 'Warm and curious.',
        legacyFile: 'Hsin Default.vrm', voice });
    const second = store.createCharacter({ name: 'Other', legacyFile: 'Hsin Default.vrm',
        voice: { ...voice, backend: 'kokoro' } });
    assert.notEqual(first.id, second.id);
    assert.equal(first.modelUrl, '/models/characters/Hsin%20Default.vrm');
    assert.equal(store.readCharacter(first.id).personality, 'Warm and curious.');
    assert.equal(store.readCharacter(second.id).voice.backend, 'kokoro');
    assert.equal(fs.readFileSync(path.join(charactersDir, 'Hsin Default.vrm'), 'utf8'), 'model');
    assert.equal(fs.readFileSync(path.join(voicesDir, 'Hsin.safetensors'), 'utf8'), 'voice');
    assert.equal(store.listCharacters().length, 3); // two profiles and the selectable loose VRM

    store.updateCharacter(first.id, { name: 'Hsin Revised', voice: { pocket: 'another.safetensors' } });
    assert.equal(store.readCharacter(first.id).name, 'Hsin Revised');
    assert.equal(store.readCharacter(first.id).voice.pocket, 'another.safetensors');
    assert.equal(store.readCharacter(second.id).voice.pocket, 'Hsin.safetensors');
});

test('uploaded profiles use nested URLs, shared voice references and optional animation discovery', t => {
    const { charactersDir, voicesDir, store } = fixture(t);
    const id = randomUUID();
    const directory = store.directoryFor(id);
    fs.mkdirSync(path.join(directory, 'animations'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'model.vrm'), 'model');
    fs.writeFileSync(path.join(directory, 'animations', 'wave.vrma'), 'animation');
    fs.writeFileSync(path.join(directory, 'animations', 'flourish_bow.json'), '{}');
    fs.writeFileSync(path.join(directory, 'animations', 'ignore.txt'), 'x');
    fs.writeFileSync(path.join(voicesDir, 'Hsin.safetensors'), 'voice');
    const created = store.createCharacter({ id, name: 'Companion', model: 'model.vrm', voice });
    assert.equal(created.modelUrl, `/models/characters/${id}/model.vrm`);
    assert.deepEqual(created.animations.map(item => item.name), ['flourish_bow', 'wave']);
    assert.equal(created.animations[1].url, `/models/characters/${id}/animations/wave.vrma`);
    assert.equal(store.profileVoiceSettings({ ttsBackend: 'kokoro', voice: 'af_bella', pocketTts: { streaming: true } }, created).pocketTts.voice,
        'http://127.0.0.1:3000/voices/Hsin.safetensors');
    assert.equal(store.voiceFromSettings({ ttsBackend: 'pocket-tts', voice: 'af_nova',
        pocketTts: { voice: 'http://localhost:3000/voices/Hsin.safetensors' } }).pocket,
    'http://localhost:3000/voices/Hsin.safetensors');
    assert.equal(fs.existsSync(path.join(charactersDir, id, 'character.json')), true);
});

test('invalid IDs and model paths cannot escape the character directory', t => {
    const { store } = fixture(t);
    assert.throws(() => store.directoryFor('../voices'), { status: 400 });
    assert.throws(() => store.createCharacter({ name: 'Bad', legacyFile: '../outside.vrm', voice }), { status: 400 });
    assert.throws(() => store.createCharacter({ name: 'Bad', model: 'model.vrm', voice }), { status: 400 });
});

test('switching companions restores each voice and leaves shared TTS options intact', t => {
    const { root, charactersDir, store } = fixture(t);
    fs.writeFileSync(path.join(charactersDir, 'base.vrm'), 'model');
    const first = store.createCharacter({ name: 'First', legacyFile: 'base.vrm', voice });
    const second = store.createCharacter({ name: 'Second', legacyFile: 'base.vrm',
        voice: { backend: 'kokoro', kokoro: 'af_bella', pocket: '' } });
    const settings = createSettingsStore({ settingsPath: path.join(root, 'settings.json'), characters: store });
    settings.updateSettings({ currentCharacter: first.id });
    settings.updateSettings({ pocketTts: { voice: 'http://lan-host:3000/voices/new.safetensors' } });
    assert.equal(settings.getSettings().pocketTts.voice, 'http://lan-host:3000/voices/new.safetensors');
    assert.equal(settings.getSettings().pocketTts.baseUrl, 'http://localhost:8000');
    assert.equal(store.readCharacter(first.id).voice.pocket, 'http://lan-host:3000/voices/new.safetensors');
    settings.updateSettings({ currentCharacter: second.id });
    assert.equal(settings.getSettings().ttsBackend, 'kokoro');
    settings.updateSettings({ voice: 'af_sky' });
    settings.updateSettings({ currentCharacter: first.id });
    assert.equal(settings.getSettings().voice, 'af_nova');
    assert.equal(settings.getSettings().ttsBackend, 'pocket-tts');
    settings.updateSettings({ currentCharacter: second.id });
    assert.equal(settings.getSettings().voice, 'af_sky');
    settings.updateSettings({ currentCharacter: 'base.vrm' });
    assert.equal(settings.getSettings().voice, 'af_bella');
    assert.equal(settings.getSettings().ttsBackend, 'kokoro');
});

test('character context is fresh for each call and leaves saved messages unchanged', () => {
    const messages = [{ role: 'system', content: 'The available animations are: hello, spin.' },
        { role: 'user', content: 'Hi' }];
    const character = { id: 'profile', name: 'Hsin', personality: 'Speak softly.', legacy: false,
        animations: [{ name: 'wave' }, { name: 'idle_rest' }] };
    const result = withCharacterContext(messages, 'profile', () => character);
    assert.match(result[0].content, /hello, spin, wave/);
    assert.match(result[0].content, /You are Hsin/);
    assert.match(result[0].content, /Speak softly/);
    assert.doesNotMatch(result[0].content, /idle_rest/);
    assert.equal(messages[0].content, 'The available animations are: hello, spin.');
});
