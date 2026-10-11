import { apiFetch, requireOk } from '../apiConfig';
import { createStreamPlayback, PcmDecoder } from './streamPlayback';
import { splitVoiceText, VOICE_CHUNK_LIMIT } from '../utils/textParsing';

const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
};

export class VoicePlayback {
    constructor() {
        this.context = null;
        this.analyser = null;
        this.generationTail = Promise.resolve();
        this.playbackTail = Promise.resolve();
        this.sessions = new Set();
    }

    async getContext(sampleRate = this.context?.sampleRate || 24000) {
        if (this.context && this.context.sampleRate !== sampleRate) {
            await this.context.close();
            this.context = null;
        }
        if (!this.context) {
            this.context = new AudioContext({ sampleRate, latencyHint: 'playback' });
            this.analyser = this.context.createAnalyser();
            this.analyser.fftSize = 256;
            this.analyser.connect(this.context.destination);
        }
        if (this.context.state === 'suspended') await this.context.resume();
        return this.context;
    }

    begin({ onAnalyser, onError } = {}) {
        if (this.current && !this.current.finished) {
            this.current.finished = true;
            if (!this.current.job) this.complete(this.current);
        }
        const completion = deferred();
        const session = {
            pending: [], job: null, player: null, finished: false, error: null,
            controller: new AbortController(), onAnalyser, onError, completion,
            previous: this.playbackTail,
        };
        this.sessions.add(session);
        this.current = session;
        this.playbackTail = completion.promise;
        return session;
    }

    enqueue(text) {
        const session = this.current;
        if (!session || session.finished || session.error || !text.trim()) return;
        session.pending.push(...splitVoiceText(text));
        if (!session.pending.length) return;
        if (session.job) return;
        const run = async () => {
            try {
                while (session.pending.length && !session.controller.signal.aborted) {
                    let text = session.pending.shift();
                    // Combine sentences accumulated during generation, without
                    // waiting for more text before starting the first utterance.
                    while (session.pending.length && text.length + session.pending[0].length + 1 <= VOICE_CHUNK_LIMIT) text += ` ${session.pending.shift()}`;
                    await this.stream(text, session);
                }
            } catch (error) {
                session.error = error;
                session.pending = [];
                if (!session.controller.signal.aborted) session.onError?.(error);
            } finally {
                session.job = null;
                if (session.finished || session.error) this.complete(session);
            }
        };
        session.job = this.generationTail.then(run);
        this.generationTail = session.job.catch(() => {});
    }

    async stream(text, session) {
        const response = await requireOk(await apiFetch('/api/voice/stream', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text }), signal: session.controller.signal,
        }));
        const sampleRate = Number(response.headers.get('X-Sample-Rate'));
        const channels = Number(response.headers.get('X-Channels'));
        const bits = Number(response.headers.get('X-Bits-Per-Sample'));
        if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 96000 || ![1, 2].includes(channels) || bits !== 16) {
            await response.body?.cancel();
            throw new Error('Unsupported voice stream format (expected 16-bit PCM).');
        }
        const reader = response.body.getReader();
        try {
            if (!session.player) {
                await session.previous;
                if (session.controller.signal.aborted) return;
                const context = await this.getContext(sampleRate);
                if (session.controller.signal.aborted) return;
                session.format = { sampleRate, channels };
                session.player = await createStreamPlayback(context, this.analyser, channels);
                if (session.controller.signal.aborted) { session.player.stop(); return; }
                session.onAnalyser?.(this.analyser);
            }
            if (session.format.sampleRate !== sampleRate || session.format.channels !== channels) throw new Error('Voice stream format changed during a reply.');
            const decoder = new PcmDecoder(channels);
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const block = decoder.decode(value);
                if (block[0].length) session.player.push(block);
            }
            decoder.finish();
        } finally {
            await reader.cancel().catch(() => {});
            reader.releaseLock();
        }
    }

    async complete(session) {
        if (session.completing) return;
        session.completing = true;
        try {
            // Failed generation must not let a later reply overtake audio that
            // is still playing from an earlier reply.
            await session.previous;
            await session.player?.finish();
        } catch (error) {
            session.error ||= error;
            if (!session.controller.signal.aborted) session.onError?.(error);
        } finally {
            session.completion.resolve();
            this.sessions.delete(session);
        }
    }

    async wait() {
        const session = this.current;
        if (!session) return;
        session.finished = true;
        if (!session.job) this.complete(session);
        await session.completion.promise;
        if (session.error && !session.controller.signal.aborted) throw session.error;
    }

    async play(text, { voice = 'af_bella', onAnalyser } = {}) {
        if (!text.trim()) return;
        const session = this.begin({ onAnalyser });
        session.finished = true; // This path completes through source.onended.
        try {
            const response = await requireOk(await apiFetch('/api/voice', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text, voice }), signal: session.controller.signal,
            }));
            const bytes = await response.arrayBuffer();
            await session.previous;
            if (session.controller.signal.aborted) return;
            const context = await this.getContext();
            const buffer = await context.decodeAudioData(bytes);
            if (session.controller.signal.aborted) return;
            const source = context.createBufferSource();
            source.buffer = buffer;
            source.connect(this.analyser);
            onAnalyser?.(this.analyser);
            const ended = deferred();
            source.onended = () => { source.disconnect(); ended.resolve(); };
            session.player = { stop: () => { source.stop(); source.disconnect(); ended.resolve(); } };
            source.start();
            await ended.promise;
        } finally {
            await session.previous;
            session.completion.resolve();
            this.sessions.delete(session);
        }
    }

    stop() {
        for (const session of this.sessions) {
            session.controller.abort();
            session.player?.stop();
            session.completion.resolve();
        }
        this.sessions.clear();
        this.current = null;
        this.analyser?.disconnect();
        this.context?.close().catch(() => {});
        this.context = null;
    }
}
