// ============================================
// client/src/utils/audioCapture.js — mic audio -> 16kHz mono WAV
// Uses only the browser's native Web Audio API (no extra deps) to decode
// whatever MediaRecorder captured, downmix to mono, resample to 16kHz, and
// encode as 16-bit PCM WAV — the same WAV shape server/routes/voice.js's
// floatToWav() already produces for TTS output, so both directions of this
// app share one format.
// ============================================

// `blob` is whatever MediaRecorder produced (typically audio/webm;codecs=opus
// in Chrome/Edge) — decodeAudioData handles that natively, no server-side
// codec library needed.
export async function blobToWav16kMono(blob) {
    const arrayBuffer = await blob.arrayBuffer();
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const decoded = await audioCtx.decodeAudioData(arrayBuffer);
    audioCtx.close();

    const TARGET_SAMPLE_RATE = 16000; // what Whisper expects

    // A 1-channel OfflineAudioContext destination automatically downmixes
    // any number of source channels to mono during rendering.
    const offlineCtx = new OfflineAudioContext(
        1,
        Math.ceil(decoded.duration * TARGET_SAMPLE_RATE),
        TARGET_SAMPLE_RATE
    );
    const source = offlineCtx.createBufferSource();
    source.buffer = decoded;
    source.connect(offlineCtx.destination);
    source.start(0);

    const resampled = await offlineCtx.startRendering();
    const samples = resampled.getChannelData(0);

    return encodeWav16(samples, TARGET_SAMPLE_RATE);
}

// Mirrors server/routes/voice.js's floatToWav() so both ends of this app
// speak the exact same WAV layout.
function encodeWav16(floatData, sampleRate) {
    const bytesPerSample = 2;
    const dataLength = floatData.length * bytesPerSample;
    const buffer = new ArrayBuffer(44 + dataLength);
    const view = new DataView(buffer);

    function writeString(offset, str) {
        for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    }

    writeString(0, 'RIFF');
    view.setUint32(4, 36 + dataLength, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);  // PCM format
    view.setUint16(22, 1, true);  // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * bytesPerSample, true);
    view.setUint16(32, bytesPerSample, true);
    view.setUint16(34, 16, true); // bits per sample
    writeString(36, 'data');
    view.setUint32(40, dataLength, true);

    let offset = 44;
    for (let i = 0; i < floatData.length; i++) {
        const s = Math.max(-1, Math.min(1, floatData[i]));
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        offset += 2;
    }

    return new Blob([buffer], { type: 'audio/wav' });
}