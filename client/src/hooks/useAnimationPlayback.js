import { useEffect, useRef } from 'react';
import * as THREE from 'three';

// Returning from a held final pose needs more time than entering a gesture.
const CHANGE_FADE_SECONDS = 0.45;
const RETURN_TO_IDLE_SECONDS = 0.9;

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
    const actionMixerRef = useRef(null);
    const activeActionsRef = useRef(new Set());
    const finishListenerRef = useRef(null);

    function clearFinishListener() {
        const pending = finishListenerRef.current;
        if (pending) pending.mixer.removeEventListener('finished', pending.listener);
        finishListenerRef.current = null;
    }

    function transitionTo(action, duration) {
        const mixer = mixerRef.current;
        if (actionMixerRef.current !== mixer) {
            activeActionsRef.current.clear();
            actionMixerRef.current = mixer;
        }
        clearFinishListener();

        // A quick second switch can happen while the first fade is still in
        // progress. Fade every contributing action from its current weight so
        // neither a stale pose nor a restarted fade causes a visible jump.
        for (const previous of activeActionsRef.current) {
            if (previous === action) continue;
            if (!previous.isScheduled() || !previous.enabled) {
                activeActionsRef.current.delete(previous);
                continue;
            }
            previous.setEffectiveWeight(previous.getEffectiveWeight());
            previous.fadeOut(duration);
        }

        action.reset().setEffectiveWeight(1).fadeIn(duration).play();
        activeActionsRef.current.add(action);
        currentActionRef.current = action;
    }

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

        const action = mixer.clipAction(clip);
        if (loop && currentActionRef.current === action) return action;
        action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
        action.clampWhenFinished = !loop;
        transitionTo(action, CHANGE_FADE_SECONDS);

        if (loop) idleActionRef.current = action;

        if (!loop) {
            const onFinished = (e) => {
                if (e.action === action) {
                    clearFinishListener();
                    if (currentActionRef.current !== action) return;
                    if (onFinish) onFinish();
                    if (currentActionRef.current === action) returnToIdle();
                }
            };
            mixer.addEventListener('finished', onFinished);
            finishListenerRef.current = { mixer, listener: onFinished };
        }

        return action;
    }

    function returnToIdle() {
        const idleAction = idleActionRef.current;
        if (!idleAction || currentActionRef.current === idleAction) return;
        transitionTo(idleAction, RETURN_TO_IDLE_SECONDS);
    }

    // Picks a random idle clip from the given keys and plays it looped
    function playRandomIdle(idleKeys) {
        const randomKey = idleKeys[Math.floor(Math.random() * idleKeys.length)];
        playAnimation(randomKey, true);
    }

    // Every 2–5 min, swaps to a different random idle clip — but only if
    // nothing else (a triggered animation) is currently playing
    function startIdleRotation(idleKeys) {
        let active = true;
        let timer;
        function scheduleNext() {
            const delay = (2 + Math.random() * 3) * 60 * 1000; // 2–5 minutes
            timer = setTimeout(() => {
                if (!active) return;
                if (currentActionRef.current === idleActionRef.current) {
                    playRandomIdle(idleKeys);
                }
                scheduleNext();
            }, delay);
        }
        scheduleNext();
        return () => { active = false; clearTimeout(timer); };
    }

    // Every 15–45s, plays a short one-shot gesture (hair touch, stretch, etc.)
    // that auto-returns to idle when finished — only if idle is currently active
    function startFlourishLoop(flourishKeys) {
        if (flourishKeys.length === 0) return () => {};

        let active = true;
        let timer;
        function scheduleNext() {
            const delay = (15 + Math.random() * 30) * 1000; // 15–45 seconds, tune to taste
            timer = setTimeout(() => {
                if (!active) return;
                if (currentActionRef.current === idleActionRef.current) {
                    const key = flourishKeys[Math.floor(Math.random() * flourishKeys.length)];
                    playAnimation(key, false); // one-shot — auto-returns to idle when done
                }
                scheduleNext();
            }, delay);
        }
        scheduleNext();
        return () => { active = false; clearTimeout(timer); };
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

        for (const activeAction of activeActionsRef.current) activeAction.stop();

        clearFinishListener();
        activeActionsRef.current.clear();

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
        const activeActions = activeActionsRef.current;
        window.__scrubAnimation = scrubAnimation;
        window.__playAnimation = playAnimation;
        window.__listAnimations = () => Object.keys(loadedAnimationsRef.current);
        window.__clipDuration = (name) => loadedAnimationsRef.current[name]?.duration;
        return () => {
            clearFinishListener();
            activeActions.clear();
            delete window.__scrubAnimation;
            delete window.__playAnimation;
            delete window.__listAnimations;
            delete window.__clipDuration;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return { playAnimation, returnToIdle, playRandomIdle, startIdleRotation, startFlourishLoop, scrubAnimation };
}
