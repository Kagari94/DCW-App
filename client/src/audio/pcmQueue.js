// Runs at the source sample rate. Device resampling happens after this
// continuous output stream, rather than at each network chunk boundary.
export class PcmQueue {
    constructor(channels, bufferFrames) {
        this.channels = channels;
        this.bufferFrames = bufferFrames;
        this.blocks = [];
        this.head = 0;
        this.offset = 0;
        this.frames = 0;
        this.playing = false;
        this.finished = false;
    }

    push(block) {
        this.blocks.push(block);
        this.frames += block[0].length;
    }

    render(output) {
        output.forEach(channel => channel.fill(0));
        if (!this.playing && (this.frames >= this.bufferFrames || this.finished)) this.playing = true;
        if (!this.playing) return false;
        let written = 0;
        while (written < output[0].length && this.frames) {
            const block = this.blocks[this.head];
            const count = Math.min(block[0].length - this.offset, output[0].length - written);
            for (let ch = 0; ch < output.length; ch++) {
                output[ch].set(block[Math.min(ch, this.channels - 1)].subarray(this.offset, this.offset + count), written);
            }
            this.offset += count;
            this.frames -= count;
            written += count;
            if (this.offset === block[0].length) {
                this.blocks[this.head++] = null;
                this.offset = 0;
            }
        }
        if (this.head > 32) { this.blocks = this.blocks.slice(this.head); this.head = 0; }
        // Refill after a genuine underrun without discarding unheard samples.
        if (!this.frames) this.playing = false;
        return this.finished && !this.frames;
    }
}
