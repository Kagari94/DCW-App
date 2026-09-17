// ============================================
// server/scripts/syncExpressions.js — auto-sync VRM expressions into system prompt
// ============================================
const fs = require('fs');
const path = require('path');

const MODELS_DIR = path.join(__dirname, '../../client/public/models/characters');
const PROMPT_PATH = path.join(__dirname, '../assets/system-prompt.md');
const VRM_FILENAME = 'Rapi.vrm'; // adjust to your actual filename

// VRM 0.x preset names → VRM 1.0 preset names (what three-vrm normalizes to at runtime)
const VRM0_TO_VRM1_MAP = {
    'neutral': 'neutral',
    'a': 'aa',
    'i': 'ih',
    'u': 'ou',
    'e': 'ee',
    'o': 'oh',
    'blink': 'blink',
    'joy': 'happy',
    'angry': 'angry',
    'sorrow': 'sad',
    'fun': 'relaxed',
    'lookup': 'lookUp',
    'lookdown': 'lookDown',
    'lookleft': 'lookLeft',
    'lookright': 'lookRight',
    'blink_l': 'blinkLeft',
    'blink_r': 'blinkRight',
};

function readVrmExpressionNames(vrmPath) {
    const buffer = fs.readFileSync(vrmPath);
    const jsonChunkLength = buffer.readUInt32LE(12);
    const jsonChunkData = buffer.slice(20, 20 + jsonChunkLength).toString('utf8');
    const gltf = JSON.parse(jsonChunkData);

    const excluded = ['aa', 'ih', 'ou', 'ee', 'oh', 'blink', 'blinkLeft', 'blinkRight', 'lookUp', 'lookDown', 'lookLeft', 'lookRight'];

    const vrm1 = gltf.extensions?.VRMC_vrm;
    if (vrm1) {
        const preset = vrm1.expressions?.preset ?? {};
        const custom = vrm1.expressions?.custom ?? {};
        return [...Object.keys(preset), ...Object.keys(custom)].filter(n => !excluded.includes(n));
    }

    const vrm0 = gltf.extensions?.VRM;
    if (vrm0) {
        const groups = vrm0.blendShapeMaster?.blendShapeGroups ?? [];
        const rawNames = groups.map(g => g.name).filter(Boolean);

        // Convert VRM0 preset names to their VRM1 equivalents, matching what three-vrm uses at runtime
        const normalized = rawNames.map(name => VRM0_TO_VRM1_MAP[name.toLowerCase()] ?? name);

        return normalized.filter(n => !excluded.includes(n));
    }

    console.warn('⚠️ No VRM extension found in file — is this a valid .vrm?');
    return [];
}

function syncPrompt() {
    const vrmPath = path.join(MODELS_DIR, VRM_FILENAME);

    if (!fs.existsSync(vrmPath)) {
        console.warn(`⚠️ VRM file not found at ${vrmPath}, skipping sync`);
        return;
    }

    const expressionNames = readVrmExpressionNames(vrmPath);

    let promptText = fs.readFileSync(PROMPT_PATH, 'utf8');

    // Reset placeholder if previously replaced
    promptText = promptText.replace(/The only valid expressions are: .+/, 'The only valid expressions are: {{EXPRESSIONS}}');

    const tagList = expressionNames.map(n => `<expression>${n}</expression>`).join(', ');
    promptText = promptText.replace('{{EXPRESSIONS}}', tagList);

    fs.writeFileSync(PROMPT_PATH, promptText, 'utf8');
    console.log(`✅ Synced ${expressionNames.length} expressions into system prompt:`, expressionNames);
}

function watchForChanges() {
    syncPrompt(); // run once immediately on startup

    fs.watch(MODELS_DIR, (eventType, filename) => {
        if (filename === VRM_FILENAME) {
            console.log(`🔄 Detected change in ${filename}, re-syncing expressions...`);
            // Small delay to let the file write fully settle before reading
            setTimeout(syncPrompt, 300);
        }
    });
}

module.exports = { syncPrompt, watchForChanges };