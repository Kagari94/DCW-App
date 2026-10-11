import workletUrl from './pcmWorklet.js?worker&url';

const BUFFER_SECONDS = 0.32;
const BLOCK_SECONDS = 0.12;
const loadedWorklets = new WeakMap();

// HTTP pages on a LAN may lack AudioWorklet. Aggregate PCM into fixed blocks
// and keep a reserve there too; completion is recorded before playback starts.
export class BufferedPlayback {
    constructor(context, destination, channels) {
        this.context = context;
        this.destination = destination;
        this.channels = channels;
        this.pending = [];
        this.frames = 0;
        this.nextStart = 0;
        this.started = false;
        this.sources = new Set();
        this.finished = false;
        this.done = new Promise(resolve => { this.resolve = resolve; });
    }

    push(channels) {
        this.pending.push(channels);
        this.frames += channels[0].length;
        this.flush();
    }

    flush() {
        const ctx = this.context;
        if (this.started && this.nextStart <= ctx.currentTime) this.started = false;
        if (!this.started && !this.finished && this.frames < ctx.sampleRate * BUFFER_SECONDS) return;
        const blockFrames = Math.ceil(ctx.sampleRate * BLOCK_SECONDS);
        while (this.frames >= blockFrames || (this.finished && this.frames)) {
            const count = Math.min(this.frames, blockFrames);
            const buffer = ctx.createBuffer(this.channels, count, ctx.sampleRate);
            let offset = 0;
            while (offset < count) {
                const block = this.pending[0];
                const take = Math.min(count - offset, block[0].length);
                for (let ch = 0; ch < this.channels; ch++) buffer.getChannelData(ch).set(block[ch].subarray(0, take), offset);
                if (take === block[0].length) this.pending.shift();
                else this.pending[0] = block.map(channel => channel.subarray(take));
                offset += take;
            }
            this.frames -= count;
            const source = ctx.createBufferSource();
            source.buffer = buffer;
            source.connect(this.destination);
            this.sources.add(source);
            source.onended = () => {
                source.disconnect();
                this.sources.delete(source);
                this.checkDone();
            };
            const start = Math.max(this.nextStart, ctx.currentTime + 0.02);
            source.start(start);
            this.nextStart = start + buffer.duration;
            this.started = true;
        }
        this.checkDone();
    }

    checkDone() {
        if (this.finished && !this.frames && !this.sources.size) this.resolve();
    }

    finish() { this.finished = true; this.flush(); return this.done; }

    stop() {
        for (const source of this.sources) { source.stop(); source.disconnect(); }
        this.sources.clear();
        this.pending = [];
        this.frames = 0;
        this.finished = true;
        this.resolve();
    }
}

export async function createStreamPlayback(context, destination, channels) {
    if (!context.audioWorklet || typeof AudioWorkletNode === 'undefined') {
        return new BufferedPlayback(context, destination, channels);
    }
    if (!loadedWorklets.has(context)) loadedWorklets.set(context, context.audioWorklet.addModule(workletUrl));
    await loadedWorklets.get(context);
    const node = new AudioWorkletNode(context, 'companion-pcm-player', {
        numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [channels],
        processorOptions: { channels, bufferFrames: Math.ceil(context.sampleRate * BUFFER_SECONDS) },
    });
    node.connect(destination);
    let resolve, reject;
    const done = new Promise((ok, fail) => { resolve = ok; reject = fail; });
    done.catch(() => {}); // Processor errors can precede finish().
    const disconnect = () => { node.disconnect(); node.port.close(); };
    node.port.onmessage = ({ data }) => {
        if (data.type === 'ended') { disconnect(); resolve(); }
    };
    node.onprocessorerror = () => { disconnect(); reject(new Error('Voice audio processor failed.')); };
    return {
        push: channels => node.port.postMessage({ type: 'samples', channels }, channels.map(channel => channel.buffer)),
        finish: () => { node.port.postMessage({ type: 'finish' }); return done; },
        stop: () => { disconnect(); resolve(); },
    };
}

export class PcmDecoder {
    constructor(channels) {
        this.channels = channels;
        this.leftover = new Uint8Array(0);
        this.frames = 0;
    }

    decode(bytes) {
        const combined = new Uint8Array(this.leftover.length + bytes.length);
        combined.set(this.leftover);
        combined.set(bytes, this.leftover.length);
        const frameBytes = this.channels * 2;
        const usable = combined.length - combined.length % frameBytes;
        this.leftover = combined.slice(usable);
        const frames = usable / frameBytes;
        this.frames += frames;
        const view = new DataView(combined.buffer, 0, usable);
        return Array.from({ length: this.channels }, (_, ch) => {
            const output = new Float32Array(frames);
            for (let i = 0; i < frames; i++) output[i] = view.getInt16(i * frameBytes + ch * 2, true) / 32768;
            return output;
        });
    }

    finish() {
        if (this.leftover.length || !this.frames) throw new Error('Voice stream ended with incomplete or missing PCM audio.');
    }
}
