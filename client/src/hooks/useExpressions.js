// Expressions known to visually close/squint the eyes but don't share
// morph targets with 'blink' (so auto-detection can't find them) —
// add more names here if you notice other expressions blink through
export const MANUAL_EYE_CLOSING_EXPRESSIONS = ['happy'];

// Expression blending, eye-closing detection, and the blink loop.
// eyeClosingExpressionsRef is owned by the parent (populated once per VRM
// load by useVrmModel) so this hook and the model-loading hook share it.
export default function useExpressions({ vrmRef, eyeClosingExpressionsRef }) {
    function setExpression(name, intensity = 1.0, duration = 0.3) {
        const vrm = vrmRef.current;
        if (!vrm?.expressionManager) return;

        const manager = vrm.expressionManager;
        const startVal = manager.getValue(name) ?? 0;
        const startTime = performance.now();

        function blend() {
            const elapsed = (performance.now() - startTime) / 1000;
            const t = Math.min(elapsed / duration, 1.0);
            manager.setValue(name, startVal + (intensity - startVal) * t);
            if (t < 1.0) requestAnimationFrame(blend);
        }
        blend();
    }

    function resetExpressions(duration = 0.3) {
        const vrm = vrmRef.current;
        if (!vrm?.expressionManager) return;

        const expressions = Object.keys(vrm.expressionManager._expressionMap);
        expressions.forEach(name => {
            if (name !== 'neutral') setExpression(name, 0.0, duration);
        });
        setExpression('neutral', 1.0, duration);
    }

    // Auto-detect which expressions close the eyes, by comparing morph target
    // binds to blink's own binds (catches blinkLeft/blinkRight automatically
    // via bind-key overlap). Anything that closes eyes through a *different*
    // shape key won't be caught here — that's what MANUAL_EYE_CLOSING_EXPRESSIONS is for.
    function getEyeClosingExpressionNames(vrm) {
        try {
            const manager = vrm.expressionManager;
            if (!manager) return [];

            const blinkExpression = manager._expressionMap?.blink;
            if (!blinkExpression || !blinkExpression.binds) {
                console.warn('⚠️ Could not find blink expression binds — skipping eye-closing detection');
                return [];
            }

            const blinkBindKeys = new Set(
                blinkExpression.binds.map(b => `${b.primitives?.[0]?.uuid ?? b.mesh}:${b.index}`)
            );

            const eyeClosing = [];
            for (const [name, expression] of Object.entries(manager._expressionMap)) {
                if (name === 'blink' || name === 'neutral') continue;
                if (!expression.binds) continue;
                const overlaps = expression.binds.some(b =>
                    blinkBindKeys.has(`${b.primitives?.[0]?.uuid ?? b.mesh}:${b.index}`)
                );
                if (overlaps) eyeClosing.push(name);
            }
            return eyeClosing;
        } catch (err) {
            console.error('❌ getEyeClosingExpressionNames failed:', err);
            return [];
        }
    }

    function startBlinking() {
        function blink() {
            const vrm = vrmRef.current;
            if (!vrm?.expressionManager) {
                setTimeout(blink, 1000);
                return;
            }

            const manager = vrm.expressionManager;
            const eyesAlreadyClosed = eyeClosingExpressionsRef.current.some(
                name => (manager.getValue(name) ?? 0) > 0.5
            );

            if (!eyesAlreadyClosed) {
                setExpression('blink', 1.0, 0.06);
                setTimeout(() => setExpression('blink', 0.0, 0.1), 120);

                if (Math.random() < 0.15) {
                    setTimeout(() => {
                        setExpression('blink', 1.0, 0.06);
                        setTimeout(() => setExpression('blink', 0.0, 0.1), 120);
                    }, 300);
                }
            }

            const nextBlink = 2000 + Math.random() * 4000;
            setTimeout(blink, nextBlink);
        }
        blink();
    }

    return { setExpression, resetExpressions, getEyeClosingExpressionNames, startBlinking };
}
