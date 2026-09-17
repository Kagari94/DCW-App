// ============================================
// server/settings.js — persistent runtime settings, overriding config.js defaults
// ============================================
const fs = require('fs');
const path = require('path');
const defaults = require('./config.js');

const SETTINGS_PATH = path.join(__dirname, 'data', 'settings.json');

// Computes the actual fields toolCallLoop.js / the /models route read
// (AI_API_URL, MODEL_NAME, API_KEY) from whichever provider is active.
// This is the ONLY place that needs to know multiple providers exist —
// everything downstream keeps reading three plain fields like before.
function deriveModelConfig(llm) {
    const providerId = llm?.provider || 'lmstudio';
    const cfg = llm?.providers?.[providerId] || {};

    if (providerId === 'openai') {
        return {
            AI_API_URL: 'https://api.openai.com/v1/chat/completions',
            MODEL_NAME: cfg.model || 'gpt-4o-mini',
            API_KEY: cfg.apiKey || '',
        };
    }
    if (providerId === 'custom') {
        return {
            AI_API_URL: cfg.baseUrl || '',
            MODEL_NAME: cfg.model || '',
            API_KEY: cfg.apiKey || '',
        };
    }
    // lmstudio (default) — no API key needed for a local server
    return {
        AI_API_URL: cfg.baseUrl || defaults.AI_API_URL,
        MODEL_NAME: cfg.model || defaults.MODEL_NAME,
        API_KEY: '',
    };
}

function baseSeed() {
    return {
        llm: {
            provider: 'lmstudio',
            providers: {
                lmstudio: { baseUrl: defaults.AI_API_URL, model: defaults.MODEL_NAME },
                openai: { apiKey: '', model: 'gpt-4o-mini' },
                custom: { baseUrl: '', apiKey: '', model: '' },
            },
        },
        // Derived from llm above — see deriveModelConfig. Kept as plain top-
        // level fields so every existing consumer (toolCallLoop.js, the
        // /models route) never needs to know providers exist at all.
        MODEL_NAME: defaults.MODEL_NAME,
        AI_API_URL: defaults.AI_API_URL,
        API_KEY: defaults.API_KEY || '',

        currentCharacter: null,
        backgroundColor: '#1a1a1a',
        voice: 'af_bella',
        lighting: {
            key: { color: '#ffd5aa', intensity: 1.2 },
            fill: { color: '#aaaaff', intensity: 0.6 },
            rim: { color: '#8888aa', intensity: 0.6 },
            ambient: { color: '#404040', intensity: 0.4 },
        },
        voiceInput: {
            enabled: false,
            mode: 'push-to-talk',
            wakeWord: 'hey assistant',
            whisperModel: 'Xenova/whisper-base.en',
            wakeWordPollModel: 'Xenova/whisper-tiny.en',
        },
        ttsBackend: 'kokoro',
        pocketTts: {
            baseUrl: 'http://localhost:8000',
            voice: '',
            streaming: false,
        },
        webSearch: {
            provider: 'searxng', // self-hosted, no key/card needed — see web.js
            apiKey: '',
            searxngUrl: 'http://localhost:8888',
        },
        fileAccess: {
            rootPath: '',
        },
    };
}

function ensureSettingsFile() {
    const dir = path.dirname(SETTINGS_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(SETTINGS_PATH)) {
        fs.writeFileSync(SETTINGS_PATH, JSON.stringify(baseSeed(), null, 2));
    }
}

function getSettings() {
    ensureSettingsFile();
    const overrides = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    const seed = baseSeed();
    return { ...defaults, ...seed, ...overrides };
}

function updateSettings(partial) {
    ensureSettingsFile();
    const current = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    let merged = { ...current, ...partial };

    // llm needs a deeper merge than the shallow spread above — otherwise
    // saving one provider's field (or switching the active provider) would
    // silently wipe out every other provider's remembered settings, since
    // `partial.llm.providers` only ever contains the one provider actually
    // being edited.
    if (partial.llm) {
        merged.llm = { ...(current.llm || {}), ...partial.llm };
        if (partial.llm.providers) {
            const mergedProviders = { ...(current.llm?.providers || {}) };
            for (const key of Object.keys(partial.llm.providers)) {
                mergedProviders[key] = {
                    ...(current.llm?.providers?.[key] || {}),
                    ...partial.llm.providers[key],
                };
            }
            merged.llm.providers = mergedProviders;
        }
        merged = { ...merged, ...deriveModelConfig(merged.llm) };
    }

    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(merged, null, 2));
    return { ...defaults, ...merged };
}

module.exports = { getSettings, updateSettings };