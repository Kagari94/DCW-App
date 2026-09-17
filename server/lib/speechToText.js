// ============================================
// server/lib/speechToText.js — local Whisper transcription via transformers.js
// ============================================

// @huggingface/transformers is ESM-only, same situation as kokoro-js in
// voice.js — loaded via dynamic import() inside this CJS file, which works
// fine, and cached in module scope so it isn't re-imported per request.
let pipelineFn = null;

// Keyed by model name, NOT a single slot — wake-word mode deliberately
// switches between a cheap polling model and the main command model on
// every cycle (see useVoiceInput.js), so caching only "the last one used"
// would mean reloading both models' weights back and forth every ~4s,
// which would be worse than not having this optimization at all.
const transcriberCache = new Map();

async function getPipelineFn() {
    if (!pipelineFn) {
        ({ pipeline: pipelineFn } = await import('@huggingface/transformers'));
    }
    return pipelineFn;
}

async function loadTranscriber(modelName) {
    if (transcriberCache.has(modelName)) return transcriberCache.get(modelName);

    const pipeline = await getPipelineFn();
    console.log(`🎙️  Loading Whisper model: ${modelName} (first use downloads + caches it, like Kokoro does)`);
    const transcriber = await pipeline('automatic-speech-recognition', modelName);
    transcriberCache.set(modelName, transcriber);
    console.log(`🎙️  Whisper model ready: ${modelName}`);

    return transcriber;
}

// Parses a 16-bit PCM mono WAV buffer back into a Float32Array of samples.
// This is the exact inverse of voice.js's floatToWav() — the client encodes
// its resampled mic audio into the same WAV shape that function produces,
// so both directions of this app speak one shared format instead of needing
// a separate audio-decoding dependency (ffmpeg/wavefile) just for input.
function wavToFloat32(buffer) {
    if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
        throw new Error('Not a valid WAV buffer.');
    }
    const bitsPerSample = buffer.readUInt16LE(34);
    if (bitsPerSample !== 16) {
        throw new Error(`Expected 16-bit PCM WAV, got ${bitsPerSample}-bit.`);
    }
    const numChannels = buffer.readUInt16LE(22);
    if (numChannels !== 1) {
        throw new Error(`Expected mono WAV, got ${numChannels} channels.`);
    }

    const dataLength = buffer.readUInt32LE(40);
    const sampleCount = dataLength / 2;
    const floatData = new Float32Array(sampleCount);

    for (let i = 0; i < sampleCount; i++) {
        const sample = buffer.readInt16LE(44 + i * 2);
        floatData[i] = sample / (sample < 0 ? 0x8000 : 0x7fff);
    }

    return floatData;
}

// `wavBuffer` must already be 16kHz mono — Whisper expects 16kHz audio, and
// transformers.js does not resample a raw sample array for you (resampling
// happens client-side, in utils/audioCapture.js, using the browser's own
// Web Audio API rather than a server-side codec library).
async function transcribe(wavBuffer, modelName) {
    const transcriber = await loadTranscriber(modelName);
    const audioData = wavToFloat32(wavBuffer);
    const output = await transcriber(audioData, { sampling_rate: 16000 });
    return (output.text || '').trim();
}

module.exports = { transcribe };