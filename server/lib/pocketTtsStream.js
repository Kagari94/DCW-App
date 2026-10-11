const { once } = require('node:events');

// WAV chunks are not always the usual 44-byte header: optional metadata and
// extended fmt chunks must be skipped before any bytes are treated as PCM.
class WavPcmParser {
    constructor() {
        this.header = Buffer.alloc(0);
        this.offset = 12;
        this.format = null;
        this.ready = false;
        this.bytes = 0;
    }

    push(chunk) {
        if (this.ready) { this.bytes += chunk.length; return chunk; }
        this.header = Buffer.concat([this.header, chunk]);
        if (this.header.length < 12) return Buffer.alloc(0);
        if (this.header.toString('ascii', 0, 4) !== 'RIFF' || this.header.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Pocket TTS returned an invalid WAV header.');
        while (this.header.length >= this.offset + 8) {
            const type = this.header.toString('ascii', this.offset, this.offset + 4);
            const size = this.header.readUInt32LE(this.offset + 4);
            const start = this.offset + 8;
            if (type === 'data') {
                if (!this.format) throw new Error('WAV audio is missing its PCM format.');
                this.ready = true;
                const pcm = this.header.subarray(start);
                this.header = null;
                this.bytes += pcm.length;
                return pcm;
            }
            const end = start + size + size % 2;
            if (end > 65536) throw new Error('Pocket TTS WAV header is too large.');
            if (this.header.length < end) break;
            if (type === 'fmt ') {
                if (size < 16) throw new Error('Invalid WAV format chunk.');
                const encoding = this.header.readUInt16LE(start);
                const channels = this.header.readUInt16LE(start + 2);
                const sampleRate = this.header.readUInt32LE(start + 4);
                const blockAlign = this.header.readUInt16LE(start + 12);
                const bits = this.header.readUInt16LE(start + 14);
                if (encoding !== 1 || bits !== 16 || ![1, 2].includes(channels) || sampleRate < 8000 || sampleRate > 96000 || blockAlign !== channels * 2) throw new Error('Pocket TTS must return 16-bit PCM WAV audio.');
                this.format = { channels, sampleRate, bits, blockAlign };
            }
            this.offset = end;
        }
        return Buffer.alloc(0);
    }

    finish() {
        // Pocket streams use placeholder RIFF/data lengths on unseekable output.
        // Validate actual frames, rather than requiring the declared byte count.
        if (!this.ready || !this.bytes || this.bytes % this.format.blockAlign) throw new Error('Pocket TTS returned an incomplete audio stream.');
    }
}

async function relayPocketStream(upstream, res, signal) {
    const parser = new WavPcmParser();
    for await (const chunk of upstream) {
        signal.throwIfAborted();
        const pcm = parser.push(chunk);
        if (parser.ready && !res.headersSent) {
            res.writeHead(200, {
                'Content-Type': 'application/octet-stream',
                'X-Sample-Rate': String(parser.format.sampleRate),
                'X-Channels': String(parser.format.channels),
                'X-Bits-Per-Sample': String(parser.format.bits),
                'Cache-Control': 'no-store, no-transform',
                'X-Accel-Buffering': 'no',
                'Access-Control-Expose-Headers': 'X-Sample-Rate, X-Channels, X-Bits-Per-Sample',
            });
            res.flushHeaders();
        }
        if (pcm.length && !res.write(pcm)) await once(res, 'drain', { signal });
    }
    parser.finish();
    res.end();
}

module.exports = { WavPcmParser, relayPocketStream };
