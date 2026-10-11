import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

let vite, dom, PcmDecoder, BufferedPlayback, VoicePlayback, fetchHandler, cleanTextForVoice, cleanTextForDisplay, getVoiceSentences, splitVoiceText;
const originalFetch = globalThis.fetch;
const tick = () => new Promise(resolve => setImmediate(resolve));
const headers = { 'X-Sample-Rate': '24000', 'X-Channels': '1', 'X-Bits-Per-Sample': '16' };
const pcm = new Uint8Array(2400 * 2);

class AudioContextMock {
    static instances = [];
    constructor({ sampleRate }) { this.sampleRate = sampleRate; this.currentTime = 0; this.state = 'running'; this.destination = {}; this.sources = []; AudioContextMock.instances.push(this); }
    createAnalyser() { return { connect() {}, disconnect() {} }; }
    createBuffer(channels, frames, rate) {
        const data = Array.from({ length: channels }, () => new Float32Array(frames));
        return { duration: frames / rate, data, getChannelData: ch => data[ch] };
    }
    createBufferSource() {
        const source = { connect() {}, disconnect() {}, stop() {}, start(time) { assert.equal(typeof this.onended, 'function'); this.startAt = time; } };
        this.sources.push(source);
        return source;
    }
    endAll() { for (const source of this.sources) source.onended(); this.sources = []; }
    async close() { this.state = 'closed'; }
    async decodeAudioData() { return this.createBuffer(1, 2400, this.sampleRate); }
}

before(async () => {
    dom = new JSDOM('', { url: 'http://localhost:5173' });
    globalThis.window = dom.window;
    globalThis.localStorage = dom.window.localStorage;
    globalThis.AudioContext = AudioContextMock;
    globalThis.fetch = (url, options) => url.endsWith('/health') ? Promise.resolve(new Response('{}')) : fetchHandler(url, options);
    vite = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), server: { middlewareMode: true, hmr: false, ws: false } });
    ({ PcmDecoder, BufferedPlayback } = await vite.ssrLoadModule('/src/audio/streamPlayback.js'));
    ({ VoicePlayback } = await vite.ssrLoadModule('/src/audio/voicePlayback.js'));
    ({ cleanTextForVoice, cleanTextForDisplay, getVoiceSentences, splitVoiceText } = await vite.ssrLoadModule('/src/utils/textParsing.js'));
});

after(async () => { await vite?.close(); dom?.window.close(); globalThis.fetch = originalFetch; delete globalThis.AudioContext; });

test('stock speech removes redundant tickers and speaks currencies, decimal digits and percentages', () => {
    const text = 'September 28, 2026, NVIDIA (NVDA) stock closed at $228.52. This represents a small drop of $0.34 (or -0.15%) from its previous closing price.';
    assert.equal(cleanTextForVoice(text), 'September 28, 2026, NVIDIA stock closed at 228 point five two dollars. This represents a small drop of 0 point three four dollars (or minus 0 point one five percent) from its previous closing price.');
    assert.equal(cleanTextForDisplay(text), text);
    assert.equal(cleanTextForVoice('Apple (AAPL) shares gained +1.50%. NVIDIA Corp. (NVDA) closed at $1.'),
        'Apple shares gained plus 1 point five zero percent. NVIDIA Corp. closed at 1 dollar.');
    assert.equal(cleanTextForVoice('Prices: $1,234.50, -$2.05, $-3.40, €1, £2, and $1.2 billion.'),
        'Prices: 1234 point five zero dollars, minus 2 point zero five dollars, minus 3 point four zero dollars, 1 euro, 2 pounds, and 1 point two billion dollars.');
});

test('decimal cleanup leaves sentence punctuation, dates, versions, addresses and other acronyms intact', () => {
    assert.equal(cleanTextForVoice('The value is 0.15. It was −0.05 and is now 2.00.'),
        'The value is 0 point one five. It was minus 0 point zero five and is now 2 point zero zero.');
    const text = 'September 28, 2026. Version v1.2.3 uses 192.168.1.1. Graphics Processing Unit (GPU) support is enabled.';
    assert.equal(cleanTextForVoice(text), text);
});

test('streaming prices never drop the sentence prefix or split a decimal at a token boundary', () => {
    const text = '<expression>happy</expression> **NVIDIA (NVDA)** stock closed at **$228.52**. The drop was $0.34 (or -0.15%). Done.';
    let start = 0;
    const spoken = [];
    for (let i = 1; i <= text.length; i++) {
        const result = getVoiceSentences(text.slice(0, i), { start });
        spoken.push(...result.sentences);
        start = result.nextOffset;
    }
    spoken.push(...getVoiceSentences(text, { start, done: true }).sentences);
    assert.deepEqual(spoken, ['NVIDIA stock closed at 228 point five two dollars.',
        'The drop was 0 point three four dollars (or minus 0 point one five percent).', 'Done.']);
    assert.deepEqual(getVoiceSentences('The price is $228.'), { sentences: [], nextOffset: 0 });
    assert.deepEqual(getVoiceSentences('The price is $228.52. '), {
        sentences: ['The price is 228 point five two dollars.'], nextOffset: 21,
    });
});

test('streaming keeps company abbreviations and quoted sentence endings together', () => {
    const text = 'NVIDIA Corp. (NVDA) stock closed at $228.52. She said "Up 0.15%." No final punctuation';
    assert.deepEqual(getVoiceSentences(text, { done: true }).sentences, [
        'NVIDIA Corp. stock closed at 228 point five two dollars.',
        'She said "Up 0 point one five percent."', 'No final punctuation',
    ]);
});

test('voice skips tables and their captions while retaining the recommendation and normal display', () => {
    const text = 'An introductory sentence.\n\n### Summary Table\n| GPU | VRAM | Estimated Price | Best For... |\n| :--- | :--- | :--- | :--- |\n| RTX 3090 | 24GB | $700 - $900 | Training |\n\n**Recommendation:** Get the RTX 3090 for under $800.';
    assert.equal(cleanTextForVoice(text), 'An introductory sentence. Recommendation: Get the RTX 3090 for under 800 dollars.');
    assert.equal(cleanTextForDisplay(text), text);
    let start = 0;
    const spoken = [];
    for (let i = 1; i <= text.length; i++) {
        const result = getVoiceSentences(text.slice(0, i), { start });
        spoken.push(...result.sentences);
        start = result.nextOffset;
    }
    spoken.push(...getVoiceSentences(text, { start, done: true }).sentences);
    assert.deepEqual(spoken, ['An introductory sentence.', 'Recommendation: Get the RTX 3090 for under 800 dollars.']);
    assert.equal(cleanTextForVoice('Before.\nGPU\tVRAM\tPrice\nRTX 3090\t24GB\t$900\n\nAfter.'), 'Before. After.');
});

test('table headers without outer pipes remain silent across streaming deltas', () => {
    const text = 'Intro.\nName | Best for...\n--- | ---\nRTX 3090 | Training\n\nNext sentence.';
    let start = 0;
    const spoken = [];
    for (let i = 1; i <= text.length; i++) {
        const result = getVoiceSentences(text.slice(0, i), { start });
        spoken.push(...result.sentences);
        start = result.nextOffset;
    }
    spoken.push(...getVoiceSentences(text, { start, done: true }).sentences);
    assert.deepEqual(spoken, ['Intro.', 'Next sentence.']);
});

test('list markers do not become standalone utterances, while ranges and memory sizes are spoken', () => {
    const text = 'Here are options for 2025-2026:\n\n### 1. Used cards\n* NVIDIA RTX 3090 (24GB) costs $600–$900.\n\n### 2. New cards\n* NVIDIA CMP 100-210 (16GB) costs $700 - $900.\n3. A third option has 16GB–32GB.';
    const spoken = getVoiceSentences(text, { done: true }).sentences;
    assert.deepEqual(spoken, [
        'Here are options for 2025 to 2026: Used cards NVIDIA RTX 3090 (24 gigabytes) costs 600 dollars to 900 dollars.',
        'New cards NVIDIA CMP 100-210 (16 gigabytes) costs 700 dollars to 900 dollars.',
        'A third option has 16 gigabytes to 32 gigabytes.',
    ]);
    assert.equal(cleanTextForVoice('$600–900, $700 - $900, and $300–$400.'),
        '600 dollars to 900 dollars, 700 dollars to 900 dollars, and 300 dollars to 400 dollars.');
});

test('contents lists and fenced code are excluded without removing actual prose', () => {
    const text = '# Table of Contents\n\n1. [Overview](#overview)\n2. Details\n\n## Overview\nRead this sentence.\n\n```js\nconst number = 1.2;\n```\n\nContinue here.';
    assert.equal(cleanTextForVoice(text), 'Overview Read this sentence. Continue here.');
    assert.deepEqual(getVoiceSentences(text, { done: true }).sentences, ['Overview Read this sentence.', 'Continue here.']);
});

test('long prose splits at words or clauses into bounded, punctuated utterances without losing text', () => {
    const text = Array.from({ length: 180 }, (_, i) => `word${i}`).join(' ');
    const chunks = splitVoiceText(text);
    assert.ok(chunks.length > 1);
    assert.ok(chunks.every(chunk => chunk.length <= 400 && chunk.endsWith('.')));
    assert.equal(chunks.map(chunk => chunk.slice(0, -1)).join(' '), text);
    assert.deepEqual(splitVoiceText('| :--- |'), []);
    assert.deepEqual(splitVoiceText('A finished sentence.'), ['A finished sentence.']);
});

test('voice generation receives bounded prose chunks and makes no request for a table-only reply', async () => {
    const playback = new VoicePlayback();
    const requests = [];
    fetchHandler = async (_url, options) => {
        requests.push(JSON.parse(options.body).text);
        return new Response(pcm, { headers });
    };
    await playback.play(cleanTextForVoice('| GPU | Price |\n| --- | --- |\n| RTX 3090 | $800 |'));
    assert.equal(requests.length, 0);
    const text = Array.from({ length: 180 }, (_, i) => `word${i}`).join(' ');
    playback.begin(); playback.enqueue(text);
    const done = playback.wait();
    await tick(); await tick();
    assert.ok(requests.length > 1);
    assert.ok(requests.every(request => request.length <= 400 && request.endsWith('.')));
    assert.equal(requests.map(request => request.slice(0, -1)).join(' '), text);
    playback.context.endAll();
    await done;
    playback.stop();
});

test('PCM decoder preserves signed stereo samples split at single-byte boundaries', () => {
    const bytes = Uint8Array.of(0, 128, 255, 127, 0, 64, 0, 192);
    const decoder = new PcmDecoder(2);
    const output = [[], []];
    for (const byte of bytes) decoder.decode(Uint8Array.of(byte)).forEach((channel, ch) => output[ch].push(...channel));
    decoder.finish();
    assert.deepEqual(output, [[-1, 0.5], [32767 / 32768, -0.5]]);
    decoder.decode(Uint8Array.of(1));
    assert.throws(() => decoder.finish(), /incomplete/);
});

test('fallback absorbs irregular delivery, schedules contiguous blocks, and cannot miss a late completion wait', async () => {
    const ctx = new AudioContextMock({ sampleRate: 24000 });
    const player = new BufferedPlayback(ctx, ctx.destination, 1);
    for (const time of [0, 0.06, 0.16, 0.20, 0.32]) {
        ctx.currentTime = time;
        player.push([new Float32Array(2400)]);
        if (time < 0.20) assert.equal(ctx.sources.length, 0);
    }
    ctx.sources.forEach((source, i, all) => {
        if (i) assert.ok(Math.abs(source.startAt - (all[i - 1].startAt + all[i - 1].buffer.duration)) < 1e-9);
    });
    player.finish();
    ctx.endAll();
    await player.finish();
});

test('queued sentences coalesce, and a subsequent reply waits for previous audio to finish', async () => {
    const playback = new VoicePlayback();
    const requests = [];
    let finishFirst;
    fetchHandler = async (_url, options) => {
        requests.push(JSON.parse(options.body).text);
        if (requests.length === 1) return new Response(new ReadableStream({ start(controller) { controller.enqueue(pcm); finishFirst = () => controller.close(); } }), { headers });
        return new Response(pcm, { headers });
    };
    playback.begin(); playback.enqueue('First sentence.');
    await tick();
    playback.enqueue('Second sentence.'); playback.enqueue('Third sentence.');
    const firstDone = playback.wait();
    finishFirst();
    await tick(); await tick();
    assert.deepEqual(requests, ['First sentence.', 'Second sentence. Third sentence.']);
    const context = playback.context;
    assert.ok(context.sources.length);
    playback.begin(); playback.enqueue('Another reply.');
    const secondDone = playback.wait();
    await tick();
    const previousSources = [...context.sources];
    context.endAll();
    await firstDone;
    await tick(); await tick();
    assert.ok(context.sources.length);
    assert.ok(context.sources.every(source => !previousSources.includes(source)));
    context.endAll();
    await secondDone;
    playback.stop();
});

test('generation and partial-stream failures surface instead of silently skipping speech', async () => {
    for (const fail of ['http', 'stream']) {
        const playback = new VoicePlayback();
        const errors = [];
        fetchHandler = async () => fail === 'http'
            ? new Response('{"error":"Generation failed"}', { status: 500 })
            : new Response(new ReadableStream({ start(controller) { controller.enqueue(pcm); controller.error(new Error('Disconnected')); } }), { headers });
        playback.begin({ onError: error => errors.push(error.message) });
        playback.enqueue('A sentence.');
        const done = playback.wait();
        const rejected = assert.rejects(done, fail === 'http' ? /Generation failed/ : /Disconnected/);
        await tick();
        playback.context?.endAll();
        await rejected;
        assert.equal(errors.length, 1);
        playback.stop();
    }
});

test('stopping voice aborts an in-flight request and releases its completion wait', async () => {
    const playback = new VoicePlayback();
    let signal;
    fetchHandler = (_url, options) => new Promise((_resolve, reject) => {
        signal = options.signal;
        signal.addEventListener('abort', () => reject(signal.reason));
    });
    playback.begin(); playback.enqueue('Cancelled sentence.');
    const done = playback.wait();
    await tick(); playback.stop();
    assert.equal(signal.aborted, true);
    await done;
});

test('a failed reply cannot let later audio overtake the reply still playing', async () => {
    const playback = new VoicePlayback();
    let requests = 0;
    fetchHandler = async () => ++requests === 2
        ? new Response('{"error":"Generation failed"}', { status: 500 })
        : new Response(pcm, { headers });
    playback.begin(); playback.enqueue('First.');
    const firstDone = playback.wait();
    await tick(); await tick();
    const context = playback.context;
    const firstSources = [...context.sources];
    playback.begin(); playback.enqueue('Failed.');
    const secondDone = assert.rejects(playback.wait(), /Generation failed/);
    await tick();
    playback.begin(); playback.enqueue('Third.');
    const thirdDone = playback.wait();
    await tick();
    assert.deepEqual(context.sources, firstSources);
    context.endAll();
    await firstDone; await secondDone;
    await tick(); await tick();
    assert.ok(context.sources.length);
    context.endAll();
    await thirdDone;
    playback.stop();
});

test('streamed replies wait for complete-WAV playback too', async () => {
    const playback = new VoicePlayback();
    fetchHandler = async () => new Response(pcm, { headers });
    const fullDone = playback.play('Full WAV reply.');
    await tick(); await tick();
    const context = playback.context;
    const fullSources = [...context.sources];
    playback.begin(); playback.enqueue('Streamed reply.');
    const streamDone = playback.wait();
    await tick(); await tick();
    assert.deepEqual(context.sources, fullSources);
    context.endAll(); await fullDone;
    await tick(); await tick();
    assert.ok(context.sources.length);
    context.endAll(); await streamDone;
    playback.stop();
});
