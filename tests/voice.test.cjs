const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { EventEmitter } = require('node:events');
const { readFileSync } = require('node:fs');
const { WavPcmParser, relayPocketStream } = require('../server/lib/pocketTtsStream');

test('Pocket streaming holds foreground priority until its PCM response finishes', async t => {
    const http = require('node:http');
    const express = require('express');
    const {isForegroundBusy} = require('../server/lib/memory/foreground');
    let finish;
    const upstream = http.createServer((req,res) => {
        res.writeHead(200,{'Content-Type':'audio/wav'});
        res.write(wav(Buffer.from([1,0])));
        finish = () => res.end(Buffer.from([2,0]));
    });
    await new Promise(resolve => upstream.listen(0,'127.0.0.1',resolve));
    t.after(async () => { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); });
    const settings = require('../server/settings');
    const getSettings = settings.getSettings;
    settings.getSettings = () => ({ttsBackend:'pocket-tts',pocketTts:{baseUrl:`http://127.0.0.1:${upstream.address().port}`}});
    const routeFile = require.resolve('../server/routes/voice');
    delete require.cache[routeFile];
    const router = require(routeFile);
    settings.getSettings = getSettings;
    t.after(() => { delete require.cache[routeFile]; });
    const app = express(); app.use(express.json()); app.use('/api',router);
    const server = await new Promise(resolve => { const instance=app.listen(0,'127.0.0.1',()=>resolve(instance)); });
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/voice/stream`,{
        method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:'Hello companion.'}),
    });
    assert.equal(response.status,200); assert.equal(isForegroundBusy(),true);
    const bytes = response.arrayBuffer(); finish();
    assert.deepEqual(Buffer.from(await bytes),Buffer.from([1,0,2,0]));
    assert.equal(isForegroundBusy(),false);
});

function wav(pcm, { metadata = false, bits = 16 } = {}) {
    const fmt = Buffer.alloc(24);
    fmt.write('fmt '); fmt.writeUInt32LE(16, 4);
    fmt.writeUInt16LE(1, 8); fmt.writeUInt16LE(1, 10);
    fmt.writeUInt32LE(24000, 12); fmt.writeUInt32LE(48000, 16);
    fmt.writeUInt16LE(2, 20); fmt.writeUInt16LE(bits, 22);
    const junk = metadata ? Buffer.from('JUNK\x03\0\0\0abc\0', 'binary') : Buffer.alloc(0);
    const riff = Buffer.alloc(12); riff.write('RIFF'); riff.writeUInt32LE(0x7fffffff, 4); riff.write('WAVE', 8);
    const data = Buffer.alloc(8); data.write('data'); data.writeUInt32LE(2000000000, 4);
    return Buffer.concat([riff, junk, fmt, data, pcm]);
}

test('WAV parser preserves PCM across fragmented headers, metadata and placeholder lengths', () => {
    const pcm = Buffer.from([0, 128, 255, 127, 42, 0]);
    const bytes = wav(pcm, { metadata: true });
    const parser = new WavPcmParser();
    const output = [];
    for (let i = 0; i < bytes.length; i += 3) output.push(parser.push(bytes.subarray(i, i + 3)));
    parser.finish();
    assert.deepEqual(Buffer.concat(output), pcm);
    assert.deepEqual(parser.format, { channels: 1, sampleRate: 24000, bits: 16, blockAlign: 2 });
});

test('WAV parser rejects non-PCM formats and truncated samples or headers', () => {
    assert.throws(() => new WavPcmParser().push(wav(Buffer.alloc(8), { bits: 32 })), /16-bit PCM/);
    const short = new WavPcmParser(); short.push(wav(Buffer.alloc(8)).subarray(0, 43));
    assert.throws(() => short.finish(), /incomplete/);
    const odd = new WavPcmParser(); odd.push(wav(Buffer.alloc(3)));
    assert.throws(() => odd.finish(), /incomplete/);
});

function response() {
    return Object.assign(new EventEmitter(), {
        headersSent: false, ended: false, writes: [],
        writeHead(_status, headers) { this.headersSent = true; this.headers = headers; },
        flushHeaders() {},
        write(bytes) { this.writes.push(bytes); return true; },
        end() { this.ended = true; },
    });
}

test('stream relay honors backpressure and cancellation instead of draining upstream unchecked', async () => {
    const res = response();
    let pulls = 0;
    const upstream = { async *[Symbol.asyncIterator]() {
        pulls++; yield wav(Buffer.alloc(8)); pulls++; yield Buffer.alloc(8);
    } };
    res.write = function (bytes) { this.writes.push(bytes); return false; };
    const controller = new AbortController();
    const running = relayPocketStream(upstream, res, controller.signal);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(pulls, 1);
    assert.equal(res.headers['X-Sample-Rate'], '24000');
    assert.equal(res.headers['X-Accel-Buffering'], 'no');
    controller.abort();
    await assert.rejects(running, { name: 'AbortError' });
    assert.equal(res.ended, false);
});

test('upstream failure rejects the relay without reporting successful completion', async () => {
    const upstream = Readable.from((async function* () {
        yield wav(Buffer.alloc(8));
        throw new Error('upstream disconnected');
    })());
    const res = response();
    await assert.rejects(relayPocketStream(upstream, res, new AbortController().signal), /upstream disconnected/);
    assert.equal(res.ended, false);
});

async function pcmQueue() {
    const source = readFileSync(require.resolve('../client/src/audio/pcmQueue.js'), 'utf8');
    return (await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)).PcmQueue;
}

test('high-frequency PCM is unchanged across arbitrary network and audio-render boundaries', async () => {
    const PcmQueue = await pcmQueue();
    const samples = Float32Array.from({ length: 24000 }, (_, i) => Math.sin(2 * Math.PI * 3500 * i / 24000) * 0.7);
    const queue = new PcmQueue(1, 7680);
    for (let i = 0; i < samples.length; i += 191) queue.push([samples.slice(i, i + 191)]);
    queue.finished = true;
    const output = [];
    let done;
    do {
        const block = [new Float32Array(128)];
        done = queue.render(block);
        output.push(...block[0]);
    } while (!done);
    assert.deepEqual(Float32Array.from(output.slice(0, samples.length)), samples);
    assert.ok(output.slice(samples.length).every(value => value === 0));
});

test('PCM playback buffers jitter, refills after an underrun, and flushes a short final tail', async () => {
    const PcmQueue = await pcmQueue();
    const queue = new PcmQueue(1, 4);
    const block = [new Float32Array(2)];
    queue.push([Float32Array.of(1, 2)]);
    assert.equal(queue.render(block), false); assert.deepEqual([...block[0]], [0, 0]);
    queue.push([Float32Array.of(3, 4)]);
    queue.render(block); assert.deepEqual([...block[0]], [1, 2]);
    queue.render(block); assert.deepEqual([...block[0]], [3, 4]);
    queue.push([Float32Array.of(5)]);
    queue.render(block); assert.deepEqual([...block[0]], [0, 0]);
    queue.finished = true;
    assert.equal(queue.render(block), true); assert.deepEqual([...block[0]], [5, 0]);
});
