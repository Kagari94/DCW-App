import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMAnimationLoaderPlugin, createVRMAnimationClip } from '@pixiv/three-vrm-animation';

const ANIMATIONS_BASE_PATH = '/animations';

export const ANIMATION_FILES = {
    hello: 'greeting.json',
    greeting: 'Greeting.vrma',
    peace: 'Peace_Sign.vrma',
    cheer: 'Gekirei.vrma',
    spin: 'Spin.vrma',
    pose: 'Show_Fullbody.vrma',
    modelpose: 'ModelPose.vrma',
    startle: 'Gatan.vrma',
    shoot: 'Shoot.vrma',
    respect: 'formal_bow.json'
    // note: idle removed from here, handled separately below
};

export const IDLE_ANIMATION_FILES = ['idle_1.json',  'idle_3.json']; // add/remove as you build more
export const IDLE_FLOURISH_FILES = ['idle_cooling.json', 'bashful.json', 'lookaround.json', 'happy_idle.json', 'thinking.json']; // short one-shot gestures

// Below this fraction of tracks successfully mapped, treat the clip as broken
// rather than silently playing a barely-animated (or fully T-posed) result.
const MIN_TRACK_COVERAGE = 0.5;

// Ensures consecutive keyframe quaternions stay on the same "hemisphere" of
// the double-cover (q and -q represent the IDENTICAL rotation, but which one
// is stored changes which direction slerp interpolates between two keyframes
// once the angular distance approaches/exceeds 180°). Retargeting/export
// pipelines can flip sign inconsistently between keyframes without changing
// the pose they represent at all — invisible as a static pose, but it makes
// slerp momentarily reverse direction between just that one pair of frames,
// which turns a continuous spin into a left-right wobble instead.
// Safe to apply unconditionally: well-formed tracks are unaffected (the dot
// product below is already positive throughout, so nothing gets flipped).
function fixQuaternionContinuity(track) {
    // Duck-typed via ValueTypeName rather than `instanceof
    // THREE.QuaternionKeyframeTrack` deliberately — if a library (like
    // @pixiv/three-vrm-animation) bundles/resolves its own separate copy of
    // the `three` module, tracks it creates fail an instanceof check against
    // OUR imported THREE even though they're genuinely the same kind of
    // track — same class, different module identity. ValueTypeName is a
    // plain string property, immune to that whole class of bug.
    if (track.ValueTypeName !== 'quaternion') return track;
    const values = track.values;
    for (let i = 4; i < values.length; i += 4) {
        const dot =
            values[i] * values[i - 4] +
            values[i + 1] * values[i - 3] +
            values[i + 2] * values[i - 2] +
            values[i + 3] * values[i - 1];
        if (dot < 0) {
            values[i] *= -1;
            values[i + 1] *= -1;
            values[i + 2] *= -1;
            values[i + 3] *= -1;
        }
    }
    return track;
}

// Mixamo-retargeted clips carry the SOURCE rig's absolute hip height baked
// into their position track. Applied directly to a VRM with different
// proportions, the character visibly snaps/teleports the instant the clip
// starts, since the clip's baked hip Y doesn't match THIS VRM's own rest-pose
// hip height. This offsets the whole track so its first frame lines up with
// this VRM's actual rest hip height, preserving relative motion (squats,
// jumps, bounces) while removing the snap.
//
// Deliberately reads the hips bone's LOCAL rest-pose position via the
// normalized humanoid rig — this is independent of vrm.scene.position.y (the
// whole-character world offset set in useVrmModel.js), so changing that
// offset should never affect this calculation.
function fixHipHeight(track, boneName, property, vrmRef) {
    if (boneName !== 'hips' || property !== 'position') return track;
    if (track.ValueTypeName !== 'vector') return track; // see note in fixQuaternionContinuity above

    const hipsNode = vrmRef.current.humanoid.getNormalizedBoneNode('hips');
    if (!hipsNode) return track;

    const restHipY = hipsNode.position.y;
    const clipFirstFrameY = track.values[1]; // values are flat [x0,y0,z0, x1,y1,z1, ...]
    const deltaY = restHipY - clipFirstFrameY;

    if (Math.abs(deltaY) < 1e-6) return track; // already aligned, nothing to do

    for (let i = 1; i < track.values.length; i += 3) {
        track.values[i] += deltaY;
    }
    return track;
}

// Loads a single animation clip, either:
// - a retargeted Three.js AnimationClip JSON (bone names remapped through
//   vrm.humanoid.getNormalizedBoneNode — canonical VRM bone names only, never
//   internal node names, or clips won't bind on a different three-vrm version)
// - or a legacy .vrma file (VRM animation format, loaded via VRMAnimationLoaderPlugin)
function loadAnimation(name, filePath, vrmRef, loadedAnimationsRef) {
    if (filePath.endsWith('.json')) {
        return new Promise((resolve, reject) => {
            fetch(filePath)
                .then(r => r.json())
                .then(json => {
                    const rawClip = THREE.AnimationClip.parse(json);

                    const remappedTracks = rawClip.tracks.map(track => {
                        const [boneName, property] = track.name.split('.');
                        const node = vrmRef.current.humanoid.getNormalizedBoneNode(boneName);
                        if (!node) {
                            console.warn(`Bone "${boneName}" not found on this VRM — skipping track`);
                            return null;
                        }
                        const clonedTrack = track.clone();
                        clonedTrack.name = `${node.name}.${property}`;
                        fixQuaternionContinuity(clonedTrack);
                        fixHipHeight(clonedTrack, boneName, property, vrmRef);
                        return clonedTrack;
                    }).filter(Boolean);

                    // A clip missing most of its bone tracks isn't "mostly working" —
                    // it's effectively a T-pose with a couple of twitching joints. Reject
                    // it here so loadAllAnimations' existing .catch excludes it from the
                    // idle/flourish pool entirely, instead of it silently getting picked
                    // by playRandomIdle and freezing the character.
                    const coverage = rawClip.tracks.length === 0 ? 0 : remappedTracks.length / rawClip.tracks.length;
                    if (coverage < MIN_TRACK_COVERAGE) {
                        reject(new Error(
                            `"${filePath}" only mapped ${remappedTracks.length}/${rawClip.tracks.length} bone tracks ` +
                            `(${Math.round(coverage * 100)}%) — treating as broken. Re-export it from animation-studio ` +
                            `against this same VRM.`
                        ));
                        return;
                    }

                    const clip = new THREE.AnimationClip(rawClip.name, rawClip.duration, remappedTracks);
                    loadedAnimationsRef.current[name] = clip;
                    resolve(clip);
                })
                .catch(reject);
        });
    }

    return new Promise((resolve, reject) => {
        const animLoader = new GLTFLoader();
        animLoader.register((parser) => new VRMAnimationLoaderPlugin(parser));
        animLoader.load(
            filePath,
            (gltf) => {
                const vrmAnimation = gltf.userData.vrmAnimations?.[0];
                if (!vrmAnimation) return reject(`No VRM animation found in ${filePath}`);
                const clip = createVRMAnimationClip(vrmAnimation, vrmRef.current);

                // .vrma comes from a mature, VRM-specific library that's supposed to
                // already retarget correctly across different VRMs, so we don't apply
                // the Mixamo hip-height realignment here — that's specific to the
                // ad-hoc .json pipeline, and assuming the same fix applies to a
                // format designed to already handle this could do more harm than
                // good. The quaternion continuity fix is cheap and safe regardless
                // of source though (a no-op if the data's already fine), so it's
                // applied here too — the same rotation-interpolation bug class can
                // show up in any keyframed rotation data, not just the .json path.
                clip.tracks.forEach(fixQuaternionContinuity);

                // Temporary diagnostic — logs this clip's hip track Y range. If
                // there's a real position discontinuity (as opposed to an authored
                // hop, or a visual artifact from the mixer's own crossfade
                // blending), this will show a value well outside a normal
                // standing/spinning range. Remove once we've seen real numbers.
                const hipTrack = clip.tracks.find(
                    t => t.name.toLowerCase().includes('hip') && t.name.endsWith('.position')
                );
                if (hipTrack) {
                    const yValues = [];
                    for (let i = 1; i < hipTrack.values.length; i += 3) yValues.push(hipTrack.values[i]);
                    console.log(`📏 ${filePath} hip Y range:`, Math.min(...yValues), '-', Math.max(...yValues));
                }

                loadedAnimationsRef.current[name] = clip;
                resolve(clip);
            },
            undefined,
            (error) => {
                console.warn(`⚠️ Could not load ${name}:`, error.message);
                reject(error);
            }
        );
    });
}

// Loads every configured animation (regular + idle + flourish), then kicks off
// the idle rotation and flourish loop once idle clips are ready.
export async function loadAllAnimations({
    vrmRef,
    loadedAnimationsRef,
    animationsReadyRef,
    playRandomIdle,
    startIdleRotation,
    startFlourishLoop,
}) {
    animationsReadyRef.current = true;

    const regularLoads = Object.entries(ANIMATION_FILES).map(([name, file]) =>
        loadAnimation(name, `${ANIMATIONS_BASE_PATH}/${file}`, vrmRef, loadedAnimationsRef).catch((e) => {
            console.warn(`❌ Failed to load ${name}:`, e);
            return null;
        })
    );

    const idleLoads = IDLE_ANIMATION_FILES.map((file, i) =>
        loadAnimation(`idle_${i}`, `${ANIMATIONS_BASE_PATH}/${file}`, vrmRef, loadedAnimationsRef).catch((e) => {
            console.warn(`❌ Failed to load idle_${i}:`, e);
            return null;
        })
    );

    const flourishLoads = IDLE_FLOURISH_FILES.map((file, i) =>
        loadAnimation(`flourish_${i}`, `${ANIMATIONS_BASE_PATH}/${file}`, vrmRef, loadedAnimationsRef).catch((e) => {
            console.warn(`❌ Failed to load flourish_${i}:`, e);
            return null;
        })
    );

    await Promise.allSettled([...regularLoads, ...idleLoads, ...flourishLoads]);
    console.log('✅ Loaded animations:', Object.keys(loadedAnimationsRef.current));

    const loadedIdleKeys = IDLE_ANIMATION_FILES
        .map((_, i) => `idle_${i}`)
        .filter(key => loadedAnimationsRef.current[key]);

    const loadedFlourishKeys = IDLE_FLOURISH_FILES
        .map((_, i) => `flourish_${i}`)
        .filter(key => loadedAnimationsRef.current[key]);

    if (loadedIdleKeys.length > 0) {
        playRandomIdle(loadedIdleKeys);
        startIdleRotation(loadedIdleKeys);
        startFlourishLoop(loadedFlourishKeys);
    } else {
        console.warn('⚠️ No idle animations loaded, cannot start idle loop');
    }
}