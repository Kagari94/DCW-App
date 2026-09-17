import { useRef, useCallback } from 'react';

const VISEMES = ['aa', 'ih', 'ou', 'ee', 'oh'];

function useLipSync(characterRef) {
    const rafRef = useRef(null);

    const startLipSync = useCallback((analyser) => {
        const bufferLength = analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);

        function update() {
            analyser.getByteFrequencyData(dataArray);

            let sum = 0;
            for (let i = 0; i < bufferLength; i++) sum += dataArray[i];
            const avgVolume = sum / bufferLength;

            let openness = Math.min(avgVolume / 60, 1.0);
            openness = Math.pow(openness, 0.7);

            const character = characterRef.current;
            if (!character) {
                rafRef.current = requestAnimationFrame(update);
                return;
            }

            if (openness < 0.05) {
                VISEMES.forEach(v => character.setExpression(v, 0.0, 0.04)); // was 0.08
            } else {
                const third = Math.floor(bufferLength / 3);
                const low = avgRange(dataArray, 0, third);
                const mid = avgRange(dataArray, third, third * 2);
                const high = avgRange(dataArray, third * 2, bufferLength);

                const total = low + mid + high || 1;
                const lowRatio = low / total;
                const highRatio = high / total;

                let target = 'aa';
                if (highRatio > 0.45) target = 'ee';
                else if (lowRatio > 0.55) target = 'oh';

                VISEMES.forEach(v => {
                    character.setExpression(v, v === target ? openness : 0.0, 0.03); // was 0.06
                });
            }

            rafRef.current = requestAnimationFrame(update);
        }
        update();
    }, [characterRef]);

    const stopLipSync = useCallback(() => {
        if (rafRef.current) {
            cancelAnimationFrame(rafRef.current);
            rafRef.current = null;
        }
        const character = characterRef.current;
        if (character) {
            VISEMES.forEach(v => character.setExpression(v, 0.0, 0.08)); // was 0.15
        }
    }, [characterRef]);

    return { startLipSync, stopLipSync };
}

function avgRange(arr, start, end) {
    let sum = 0;
    for (let i = start; i < end; i++) sum += arr[i];
    return sum / (end - start);
}

export default useLipSync;