// ============================================
// server/routes/settings.js — settings, model list, character list, VRM upload
// ============================================
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { getSettings, updateSettings } = require('../settings.js');
const { syncPrompt } = require('../scripts/syncExpressions.js');
const CONFIG = require('../config.js');
const { getHttpsAgent } = require('../lib/httpAgents.js');

const router = express.Router();

const CHARACTERS_DIR = path.join(__dirname, '../../client/public/models/characters');
const POCKET_VOICES_DIR = path.join(__dirname, '../data/voices');

// ---- GET/POST current settings ----
router.get('/settings', (req, res) => {
    res.json(getSettings());
});

router.post('/settings', (req, res) => {
    if (req.body.fileAccess?.rootPath) {
        const candidate = req.body.fileAccess.rootPath;
        if (!fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory()) {
            return res.status(400).json({ error: `"${candidate}" doesn't exist or isn't a folder.` });
        }
    }

    const updated = updateSettings(req.body);

    if (req.body.currentCharacter) {
        syncPrompt(req.body.currentCharacter);
    }

    res.json(updated);
});

// Known-good OpenAI API model ids as of when this list was last updated —
// OpenAI ships new models often (confirmed: several new releases in just
// the few months before this was written), so this WILL go stale. The
// client always shows a plain text field alongside this list for exactly
// that reason — never treat this as the only way to pick a model.
const OPENAI_CURATED_MODELS = [
    'gpt-4o', 'gpt-4o-mini',
    'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano',
    'o3', 'o3-mini', 'o4-mini',
    'gpt-5', 'gpt-5-mini', 'gpt-5-nano',
];

// ---- List available LLM models ----
// Accepts optional ?provider=/&baseUrl=/&apiKey= query overrides so the
// settings UI can preview a provider's model list WHILE it's being edited,
// before the user has clicked Apply and actually saved anything.
router.get('/models', async (req, res) => {
    const CONFIG = getSettings();
    const provider = req.query.provider || CONFIG.llm?.provider || 'lmstudio';

    if (provider === 'openai') {
        return res.json({ models: OPENAI_CURATED_MODELS, source: 'curated' });
    }

    const savedProviderCfg = CONFIG.llm?.providers?.[provider] || {};
    const baseUrlRaw = req.query.baseUrl || savedProviderCfg.baseUrl || (provider === 'lmstudio' ? CONFIG.AI_API_URL : '');
    const apiKey = req.query.apiKey ?? savedProviderCfg.apiKey ?? '';
    // Not exposed as a query override (unlike baseUrl/apiKey above) — the CA
    // cert is a machine-local trust setting, not something that makes sense
    // to preview ad hoc from the UI. Always comes from the saved setting.
    const caCertPath = savedProviderCfg.caCertPath || '';

    if (!baseUrlRaw) {
        return res.status(400).json({ error: 'No base URL configured for this provider yet.', models: [] });
    }

    try {
        const baseUrl = baseUrlRaw.replace(/\/chat\/completions\/?$/, '');
        const response = await axios.get(`${baseUrl}/models`, {
            headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
            timeout: 5000, // fail fast instead of hanging when the server is unreachable/closed
            httpsAgent: getHttpsAgent(caCertPath),
            proxy: false,
        });
        const models = response.data.data?.map(m => m.id) ?? [];
        res.json({ models, source: 'live' });
    } catch (error) {
        console.error('❌ Failed to fetch models:', error.message);
        res.status(503).json({ error: 'Could not reach AI server to list models.', models: [] });
    }
});

// ---- List available VRM character files ----
router.get('/characters', (req, res) => {
    try {
        if (!fs.existsSync(CHARACTERS_DIR)) {
            return res.json({ characters: [] });
        }
        const files = fs.readdirSync(CHARACTERS_DIR).filter(f => f.toLowerCase().endsWith('.vrm'));
        res.json({ characters: files });
    } catch (error) {
        console.error('❌ Failed to list characters:', error.message);
        res.status(500).json({ error: 'Could not list characters.', characters: [] });
    }
});

// ---- Upload a new VRM file ----
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        if (!fs.existsSync(CHARACTERS_DIR)) fs.mkdirSync(CHARACTERS_DIR, { recursive: true });
        cb(null, CHARACTERS_DIR);
    },
    filename: (req, file, cb) => cb(null, file.originalname),
});

const upload = multer({
    storage,
    fileFilter: (req, file, cb) => {
        if (!file.originalname.toLowerCase().endsWith('.vrm')) {
            return cb(new Error('Only .vrm files are allowed'));
        }
        cb(null, true);
    },
    limits: { fileSize: 500 * 1024 * 1024 },
});

router.post('/characters/upload', upload.single('vrm'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded, or it was rejected (must be .vrm).' });
    }
    res.json({ filename: req.file.filename });
});

const voiceUploadStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        if (!fs.existsSync(POCKET_VOICES_DIR)) fs.mkdirSync(POCKET_VOICES_DIR, { recursive: true });
        cb(null, POCKET_VOICES_DIR);
    },
    filename: (req, file, cb) => cb(null, file.originalname),
});

const uploadVoice = multer({
    storage: voiceUploadStorage,
    fileFilter: (req, file, cb) => {
        if (!file.originalname.toLowerCase().endsWith('.safetensors')) {
            return cb(new Error('Only .safetensors files are allowed'));
        }
        cb(null, true);
    },
    limits: { fileSize: 200 * 1024 * 1024 },
});

router.post('/pocket-voices/upload', uploadVoice.single('voice'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded, or it was rejected (must be .safetensors).' });
    }
    res.json({ filename: req.file.filename });
});

// ---- List available Kokoro voices ----
router.get('/voices', (req, res) => {
    const voicesDir = CONFIG.KOKORO_VOICES_DIR;

    if (!voicesDir || !fs.existsSync(voicesDir)) {
        return res.json({ voices: KOKORO_VOICES_FALLBACK, source: 'fallback' });
    }

    try {
        const files = fs.readdirSync(voicesDir)
            .filter(f => f.toLowerCase().endsWith('.bin'))
            .map(f => f.replace(/\.bin$/i, ''));
        res.json({ voices: files, source: 'folder' });
    } catch (error) {
        res.status(500).json({ error: 'Could not list voices.', voices: KOKORO_VOICES_FALLBACK });
    }
});

const KOKORO_VOICES_FALLBACK = [
    'af_alloy', 'af_aoede', 'af_bella', 'af_heart', 'af_jessica',
    'af_kore', 'af_nicole', 'af_nova', 'af_river', 'af_sarah', 'af_sky',
    'am_adam', 'am_echo', 'am_eric', 'am_fenrir', 'am_liam',
    'am_michael', 'am_onyx', 'am_puck', 'am_santa',
    'bf_alice', 'bf_emma', 'bf_isabella', 'bf_lily',
    'bm_daniel', 'bm_fable', 'bm_george', 'bm_lewis',
];

// ---- List locally exported Pocket TTS voice files ----
router.get('/pocket-voices', (req, res) => {
    try {
        if (!fs.existsSync(POCKET_VOICES_DIR)) return res.json({ voices: [] });
        const files = fs.readdirSync(POCKET_VOICES_DIR)
            .filter(f => f.toLowerCase().endsWith('.safetensors'));
        res.json({ voices: files });
    } catch (error) {
        res.status(500).json({ error: 'Could not list pocket-tts voices.', voices: [] });
    }
});

module.exports = router;