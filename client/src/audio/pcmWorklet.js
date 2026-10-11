/* global AudioWorkletProcessor, registerProcessor */
import { PcmQueue } from './pcmQueue.js';

class PcmPlayerProcessor extends AudioWorkletProcessor {
    constructor({ processorOptions }) {
        super();
        this.queue = new PcmQueue(processorOptions.channels, processorOptions.bufferFrames);
        this.port.onmessage = ({ data }) => {
            if (data.type === 'samples') this.queue.push(data.channels);
            if (data.type === 'finish') this.queue.finished = true;
        };
    }

    process(_inputs, outputs) {
        if (this.queue.render(outputs[0])) {
            this.port.postMessage({ type: 'ended' });
            return false;
        }
        return true;
    }
}

registerProcessor('companion-pcm-player', PcmPlayerProcessor);
