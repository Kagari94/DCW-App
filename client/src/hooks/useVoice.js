import { useRef, useCallback } from 'react';
import { authHeaders } from '../utils/authToken';

const API_BASE = `http://${window.location.hostname}:3000/api`;

function useVoice() {
    const audioContextRef = useRef(null);
    const nextStartTimeRef = useRef(0);
    const ttsQueueRef = useRef(Promise.resolve());
    const lastSourceRef = useRef(null);
    const analyserRef = useRef(null);

    function getAudioContext() {
        if (!audioContextRef.current) {
            audioContextRef.current = new AudioContext();
        }
        return audioContextRef.current;
    }

    // Unchanged — Kokoro path, and the pocket-tts-without-streaming fallback.
    const playVoice = useCallback(async (text, { voice = 'af_bella', onAnalyser } = {}) => {
        const audioContext = getAudioContext();
        if (audioContext.state === 'suspended') await audioContext.resume();

        const res = await fetch(`${API_BASE}/voice`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: JSON.stringify({ text, voice }),
        });

        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || 'Voice generation failed');
        }

        const arrayBuffer = await res.arrayBuffer();
        const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
        const source = audioContext.createBufferSource();
        source.buffer = audioBuffer;

        if (onAnalyser) {
            const analyser = audioContext.createAnalyser();
            analyser.fftSize = 256;
            source.connect(analyser);
            analyser.connect(audioContext.destination);
            onAnalyser(analyser);
        } else {
            source.connect(audioContext.destination);
        }

        source.start();
        return new Promise((resolve) => { source.onended = resolve; });
    }, []);

    // Call once at the start of a new reply — sets up a shared timeline
    // (nextStartTimeRef) and a single analyser that every subsequent
    // sentence connects through, so lip-sync sees one continuous signal
    // instead of restarting at each sentence boundary.
    const resetPlaybackSchedule = useCallback(({ onAnalyser } = {}) => {
        const ctx = getAudioContext();
        nextStartTimeRef.current = ctx.currentTime;
        lastSourceRef.current = null;

        if (onAnalyser) {
            const analyser = ctx.createAnalyser();
            analyser.fftSize = 256;
            analyser.connect(ctx.destination);
            analyserRef.current = analyser;
            onAnalyser(analyser);
        } else {
            analyserRef.current = null;
        }
    }, []);

    // Fetches + schedules ONE sentence's streamed audio onto the shared
    // timeline. Resolves once this sentence's chunks are fetched and
    // scheduled — NOT once they've finished playing — so the next
    // sentence's generation can start immediately behind it rather than
    // waiting out this one's playback.
    async function scheduleStreamedSentence(text) {
        const ctx = getAudioContext();
        if (ctx.state === 'suspended') await ctx.resume();

        const res = await fetch(`${API_BASE}/voice/stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: JSON.stringify({ text }),
        });

        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || 'Streamed voice generation failed');
        }

        const sampleRate = Number(res.headers.get('X-Sample-Rate')) || ctx.sampleRate;
        const channels = Number(res.headers.get('X-Channels')) || 1;

        const reader = res.body.getReader();
        let leftover = new Uint8Array(0);

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value || value.length === 0) continue;

            const combined = new Uint8Array(leftover.length + value.length);
            combined.set(leftover, 0);
            combined.set(value, leftover.length);

            const bytesPerFrame = 2 * channels;
            const usableLen = combined.length - (combined.length % bytesPerFrame);
            leftover = combined.subarray(usableLen);
            if (usableLen === 0) continue;

            const int16 = new Int16Array(combined.buffer, combined.byteOffset, usableLen / 2);
            const frameCount = int16.length / channels;
            const audioBuffer = ctx.createBuffer(channels, frameCount, sampleRate);

            for (let ch = 0; ch < channels; ch++) {
                const channelData = audioBuffer.getChannelData(ch);
                for (let i = 0; i < frameCount; i++) {
                    channelData[i] = int16[i * channels + ch] / 32768;
                }
            }

            const source = ctx.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(analyserRef.current || ctx.destination);

            const startAt = Math.max(nextStartTimeRef.current, ctx.currentTime);
            source.start(startAt);
            nextStartTimeRef.current = startAt + audioBuffer.duration;
            lastSourceRef.current = source;
        }
    }

    // Queues a sentence for generation, preserving order across the whole
    // reply, without blocking on THIS sentence's playback — only on its
    // generation+scheduling (matches pocket-tts's own serialized-generation
    // constraint, doesn't add extra unnecessary waiting on top of it).
    const enqueueSentence = useCallback((text) => {
        ttsQueueRef.current = ttsQueueRef.current
            .then(() => scheduleStreamedSentence(text))
            .catch((err) => console.error('TTS sentence failed:', err));
        return ttsQueueRef.current;
    }, []);

    // Resolves once every queued sentence has been generated+scheduled AND
    // the final scheduled chunk has actually finished playing.
    const waitForPlaybackToFinish = useCallback(async () => {
        await ttsQueueRef.current;
        if (!lastSourceRef.current) return;
        return new Promise((resolve) => { lastSourceRef.current.onended = resolve; });
    }, []);

    return { playVoice, resetPlaybackSchedule, enqueueSentence, waitForPlaybackToFinish };
}

export default useVoice;