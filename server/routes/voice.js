// ============================================
// server/routes/voice.js — Kokoro TTS generation + Whisper transcription
// ============================================
const express = require('express');
const path = require('path');
const multer = require('multer');
const { getSettings } = require('../settings.js');
const { transcribe } = require('../lib/speechToText.js');
const { relayPocketStream } = require('../lib/pocketTtsStream.js');
const router = express.Router();
const { beginForeground } = require('../lib/memory/foreground');
router.use(['/voice', '/transcribe'], (req, res, next) => {
    const release = beginForeground();
    res.once('finish', release);
    res.once('close', release);
    next();
});

let KokoroTTS;
let ttsInstance = null;
let modelDir = null;

async function loadTTS() {
    if (!KokoroTTS) {
        ({ KokoroTTS } = await import("kokoro-js"));
    }
    if (!ttsInstance) {
        ttsInstance = await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-ONNX", {
            dtype: "q8",
        });
        // Record where the model actually resolved to, so we can find its voices/ folder later
        modelDir = path.join(
            require.resolve('@huggingface/transformers').replace(/[\\/]src[\\/].*$/, ''),
            'models', 'onnx-community', 'Kokoro-82M-ONNX'
        );
    }
    return ttsInstance;
}

function getModelDir() {
    return modelDir;
}

// ---- Pocket TTS (separate local server, used for a cloned voice) ----
// POST /tts there is form-encoded (not JSON): text, plus an optional
// voice_url (built-in voice name, or an http(s)/hf:// URL — point this at an
// exported .safetensors voice so the server's own voice-state caching
// applies, rather than re-uploading/re-encoding a raw clip every request).
// Confirmed from pocket-tts's own AGENTS.md: "Server mode does not support
// concurrent requests. Batching: Batch size is always 1." — pocketTtsQueue
// below serializes our calls to it so nothing ever overlaps, regardless of
// how many chat replies fire close together.
let pocketTtsQueue = Promise.resolve();
function withPocketTtsLock(fn) {
    const run = pocketTtsQueue.then(fn, fn);
    pocketTtsQueue = run.then(() => {}, () => {}); // keep the chain alive even if this call rejected
    return run;
}

async function generatePocketTtsAudio(text, CONFIG) {
    const axios = require('axios');
    const pocketConfig = CONFIG.pocketTts || {};
    const baseUrl = pocketConfig.baseUrl || 'http://localhost:8000';

    const params = new URLSearchParams();
    params.append('text', text);
    if (pocketConfig.voice) {
        params.append('voice_url', pocketConfig.voice);
    }

    // The server streams the response, but axios with responseType
    // 'arraybuffer' waits for the full stream and hands back the complete
    // bytes — a deliberate simplification so this route's response contract
    // (one complete WAV buffer) stays identical to the Kokoro path below,
    // meaning the frontend needs zero changes. True low-latency streaming
    // through to the browser would be a separate, bigger change.
    const response = await axios.post(`${baseUrl}/tts`, params, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        responseType: 'arraybuffer',
    });

    return Buffer.from(response.data);
}

router.post('/voice', async (req, res) => {
    const { text, voice } = req.body;

    if (!text || typeof text !== 'string') {
        return res.status(400).json({ error: 'Text is required.' });
    }

    try {
        const CONFIG = getSettings();
        let wavBuffer;

        if (CONFIG.ttsBackend === 'pocket-tts') {
            wavBuffer = await withPocketTtsLock(() => generatePocketTtsAudio(text, CONFIG));
        } else {
            const tts = await loadTTS();
            const audio = await tts.generate(text, {
                voice: voice || 'af_sarah',
            });
            // audio.audio is a Float32Array, audio.sampling_rate is the sample rate
            // Convert to a WAV buffer to send over HTTP
            wavBuffer = floatToWav(audio.audio, audio.sampling_rate);
        }

        res.set('Content-Type', 'audio/wav');
        res.send(wavBuffer);

    } catch (error) {
        console.error('❌ TTS Error:', error);
        res.status(500).json({ error: `⚠️ TTS Error: ${error.message}` });
    }
});

async function streamPocketTtsAudio(text, CONFIG, res, signal) {
    const axios = require('axios');
    const pocketConfig = CONFIG.pocketTts || {};
    const baseUrl = pocketConfig.baseUrl || 'http://localhost:8000';

    const params = new URLSearchParams();
    params.append('text', text);
    if (pocketConfig.voice) {
        params.append('voice_url', pocketConfig.voice);
    }

    const upstream = await axios.post(`${baseUrl}/tts`, params, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        responseType: 'stream',
        signal,
        timeout: 60000,
    });
    await relayPocketStream(upstream.data, res, signal);
}

router.post('/voice/stream', async (req, res) => {
    const { text } = req.body;

    if (!text || typeof text !== 'string') {
        return res.status(400).json({ error: 'Text is required.' });
    }

    const CONFIG = getSettings();
    if (CONFIG.ttsBackend !== 'pocket-tts') {
        return res.status(400).json({ error: 'Streaming is only supported with the pocket-tts backend.' });
    }

    const controller = new AbortController();
    const onClose = () => controller.abort();
    res.on('close', onClose);
    try {
        await withPocketTtsLock(() => {
            controller.signal.throwIfAborted();
            return streamPocketTtsAudio(text, CONFIG, res, controller.signal);
        });
    } catch (error) {
        if (controller.signal.aborted) return;
        console.error('❌ TTS Stream Error:', error);
        if (!res.headersSent) {
            res.status(500).json({ error: `⚠️ TTS Stream Error: ${error.message}` });
        } else {
            // A normal end would disguise a truncated sentence as success.
            res.destroy();
        }
    } finally {
        res.off('close', onClose);
    }
});

// ---- Speech-to-text (Whisper via transformers.js) ----
// Audio arrives already resampled to 16kHz mono WAV by the client
// (client/src/utils/audioCapture.js) — kept in memory only, never written to
// disk, since these are short ephemeral clips rather than something worth
// persisting like chat attachments.
const uploadAudio = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB ceiling — generous for a short clip
});

router.post('/transcribe', uploadAudio.single('audio'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No audio uploaded.' });

    try {
        const CONFIG = getSettings();
        // `model` is an optional per-request override (multer parses non-file
        // multipart fields into req.body too) — wake-word mode uses this to
        // pick a cheap model for background polling chunks vs. the main
        // configured model for the actual command chunk. Falls back to the
        // settings default (used by push-to-talk, which never overrides it).
        const modelName = req.body.model || CONFIG.voiceInput?.whisperModel || 'Xenova/whisper-base.en';
        const text = await transcribe(req.file.buffer, modelName);
        res.json({ text });
    } catch (error) {
        console.error('❌ Transcription Error:', error);
        res.status(500).json({ error: `⚠️ Transcription Error: ${error.message}` });
    }
});

// Minimal WAV encoder — wraps raw PCM float data into a playable WAV buffer
function floatToWav(floatData, sampleRate) {
    const numChannels = 1;
    const bitsPerSample = 16;
    const bytesPerSample = bitsPerSample / 8;
    const blockAlign = numChannels * bytesPerSample;
    const byteRate = sampleRate * blockAlign;
    const dataLength = floatData.length * bytesPerSample;

    const buffer = Buffer.alloc(44 + dataLength);

    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + dataLength, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16); // fmt chunk size
    buffer.writeUInt16LE(1, 20); // PCM format
    buffer.writeUInt16LE(numChannels, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(byteRate, 28);
    buffer.writeUInt16LE(blockAlign, 32);
    buffer.writeUInt16LE(bitsPerSample, 34);
    buffer.write('data', 36);
    buffer.writeUInt32LE(dataLength, 40);

    // Convert float32 (-1.0 to 1.0) to int16 PCM
    let offset = 44;
    for (let i = 0; i < floatData.length; i++) {
        const s = Math.max(-1, Math.min(1, floatData[i]));
        buffer.writeInt16LE(s < 0 ? s * 0x8000 : s * 0x7FFF, offset);
        offset += 2;
    }

    return buffer;
}

module.exports = router;
module.exports.getModelDir = getModelDir;
