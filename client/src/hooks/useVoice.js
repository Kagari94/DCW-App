import { useRef, useCallback } from 'react';
import { authHeaders } from '../utils/authToken';
import { apiFetch } from '../apiConfig';

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

    const playVoice = useCallback(async (text, { voice = 'af_bella', onAnalyser } = {}) => {
        const audioContext = getAudioContext();
        if (audioContext.state === 'suspended') await audioContext.resume();

        const res = await apiFetch('/api/voice', {
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

    async function scheduleStreamedSentence(text) {
        const ctx = getAudioContext();
        if (ctx.state === 'suspended') await ctx.resume();

        const res = await apiFetch('/api/voice/stream', {
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

    const enqueueSentence = useCallback((text) => {
        ttsQueueRef.current = ttsQueueRef.current
            .then(() => scheduleStreamedSentence(text))
            .catch((err) => console.error('TTS sentence failed:', err));
        return ttsQueueRef.current;
    }, []);

    const waitForPlaybackToFinish = useCallback(async () => {
        await ttsQueueRef.current;
        if (!lastSourceRef.current) return;
        return new Promise((resolve) => { lastSourceRef.current.onended = resolve; });
    }, []);

    return { playVoice, resetPlaybackSchedule, enqueueSentence, waitForPlaybackToFinish };
}

export default useVoice;