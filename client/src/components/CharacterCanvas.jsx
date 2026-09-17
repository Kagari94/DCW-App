import { forwardRef, useImperativeHandle, useRef } from 'react';
import useThreeScene from '../hooks/useThreeScene';
import useExpressions from '../hooks/useExpressions';
import useAnimationPlayback from '../hooks/useAnimationPlayback';
import useVrmModel from '../hooks/useVrmModel';

// Orchestrator only — owns the shared refs and wires the split-out hooks
// together. Scene/render-loop, expressions, animation playback, and model
// loading each live in their own file now (see hooks/ and utils/).
const CharacterCanvas = forwardRef(({ characterFile, lighting }, ref) => {
    const vrmRef = useRef(null);
    const mixerRef = useRef(null);
    const loadedAnimationsRef = useRef({});
    const currentActionRef = useRef(null);
    const idleActionRef = useRef(null);
    const animationsReadyRef = useRef(false);
    const eyeClosingExpressionsRef = useRef([]);

    const { mountRef, sceneRef } = useThreeScene({ mixerRef, vrmRef, lighting });

    const { setExpression, resetExpressions, getEyeClosingExpressionNames, startBlinking } =
        useExpressions({ vrmRef, eyeClosingExpressionsRef });

    const { playAnimation, returnToIdle, playRandomIdle, startIdleRotation, startFlourishLoop } =
        useAnimationPlayback({ mixerRef, loadedAnimationsRef, currentActionRef, idleActionRef, animationsReadyRef });

    useVrmModel({
        characterFile,
        sceneRef,
        vrmRef,
        mixerRef,
        loadedAnimationsRef,
        currentActionRef,
        idleActionRef,
        animationsReadyRef,
        eyeClosingExpressionsRef,
        getEyeClosingExpressionNames,
        startBlinking,
        playRandomIdle,
        startIdleRotation,
        startFlourishLoop,
    });

    useImperativeHandle(ref, () => ({
        setExpression,
        resetExpressions,
        playAnimation,
        returnToIdle,
    }));

    return <div ref={mountRef} style={{ width: '100%', height: '100%' }} />;
});

export default CharacterCanvas;