import { useEffect } from 'react';
import * as THREE from 'three';

// Playback + scheduling for animation clips already loaded into loadedAnimationsRef
// (loading itself lives in utils/animationLoader.js). Owns which action is
// currently playing and which one counts as "idle" (so scheduling logic can
// check `currentActionRef.current === idleActionRef.current` to know it's
// safe to swap without interrupting a triggered animation).
export default function useAnimationPlayback({
    mixerRef,
    loadedAnimationsRef,
    currentActionRef,
    idleActionRef,
    animationsReadyRef,
}) {
    function playAnimation(name, loop = false, onFinish = null) {
        const mixer = mixerRef.current;
        if (!mixer || !animationsReadyRef.current) {
            console.warn('Animations not ready yet');
            return;
        }
        const clip = loadedAnimationsRef.current[name];
        if (!clip) {
            console.warn(`Animation "${name}" not loaded`);
            return;
        }

        if (currentActionRef.current && currentActionRef.current !== idleActionRef.current) {
            currentActionRef.current.fadeOut(0.3);
        }

        const action = mixer.clipAction(clip);
        action.reset();
        action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
        action.clampWhenFinished = !loop;
        action.fadeIn(0.3);
        action.play();

        currentActionRef.current = action;
        if (loop) idleActionRef.current = action;

        if (!loop) {
            const onFinished = (e) => {
                if (e.action === action) {
                    mixer.removeEventListener('finished', onFinished);
                    if (onFinish) onFinish();
                    returnToIdle();
                }
            };
            mixer.addEventListener('finished', onFinished);
        }

        return action;
    }

    function returnToIdle() {
        const idleAction = idleActionRef.current;
        if (!idleAction) return;

        if (currentActionRef.current && currentActionRef.current !== idleAction) {
            currentActionRef.current.fadeOut(0.3);
        }
        idleAction.reset();
        idleAction.fadeIn(0.3);
        idleAction.play();
        currentActionRef.current = idleAction;
    }

    // Picks a random idle clip from the given keys and plays it looped
    function playRandomIdle(idleKeys) {
        const randomKey = idleKeys[Math.floor(Math.random() * idleKeys.length)];
        playAnimation(randomKey, true);
    }

    // Every 2–5 min, swaps to a different random idle clip — but only if
    // nothing else (a triggered animation) is currently playing
    function startIdleRotation(idleKeys) {
        function scheduleNext() {
            const delay = (2 + Math.random() * 3) * 60 * 1000; // 2–5 minutes
            setTimeout(() => {
                if (currentActionRef.current === idleActionRef.current) {
                    playRandomIdle(idleKeys);
                }
                scheduleNext();
            }, delay);
        }
        scheduleNext();
    }

    // Every 15–45s, plays a short one-shot gesture (hair touch, stretch, etc.)
    // that auto-returns to idle when finished — only if idle is currently active
    function startFlourishLoop(flourishKeys) {
        if (flourishKeys.length === 0) return;

        function scheduleNext() {
            const delay = (15 + Math.random() * 30) * 1000; // 15–45 seconds, tune to taste
            setTimeout(() => {
                if (currentActionRef.current === idleActionRef.current) {
                    const key = flourishKeys[Math.floor(Math.random() * flourishKeys.length)];
                    playAnimation(key, false); // one-shot — auto-returns to idle when done
                }
                scheduleNext();
            }, delay);
        }
        scheduleNext();
    }

    // ---- DEBUG ONLY: freezes a clip at an exact point in time, so you can
    // step through frame-by-frame from the browser console and see exactly
    // where a rotation "skip" actually happens in the data, rather than
    // guessing from how it looks at real playback speed. Safe to delete this
    // whole block (and the useEffect below it) once you've found the bug —
    // it doesn't affect normal playback at all.
    function scrubAnimation(name, time) {
        const mixer = mixerRef.current;
        if (!mixer || !animationsReadyRef.current) {
            console.warn('Animations not ready yet');
            return;
        }
        const clip = loadedAnimationsRef.current[name];
        if (!clip) {
            console.warn(`Animation "${name}" not loaded. Try __listAnimations() to see what's available.`);
            return;
        }

        if (currentActionRef.current) {
            currentActionRef.current.stop();
        }

        const action = mixer.clipAction(clip);
        action.reset();
        action.play();
        action.paused = true; // frozen — mixer.update(0) below just re-poses at `time`, nothing advances on its own
        action.time = Math.max(0, Math.min(time, clip.duration));
        mixer.update(0);
        currentActionRef.current = action;

        console.log(`⏱️ ${name} scrubbed to ${action.time.toFixed(2)}s / ${clip.duration.toFixed(2)}s`);
        return action;
    }

    useEffect(() => {
        window.__scrubAnimation = scrubAnimation;
        window.__listAnimations = () => Object.keys(loadedAnimationsRef.current);
        window.__clipDuration = (name) => loadedAnimationsRef.current[name]?.duration;
        return () => {
            delete window.__scrubAnimation;
            delete window.__listAnimations;
            delete window.__clipDuration;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return { playAnimation, returnToIdle, playRandomIdle, startIdleRotation, startFlourishLoop, scrubAnimation };
}