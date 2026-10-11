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
    standinlook: 'standinlook.vrma',
    startle: 'Gatan.vrma',
    shoot: 'Shoot.vrma',
    respect: 'formal_bow.json'
    // note: idle removed from here, handled separately below
};

export const IDLE_ANIMATION_FILES = ['idle_1.json', 'idle_2.json', 'idle_3.json', 'standinlook.vrma'];
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

function vrmVersion(value) {
    const match = String(value).match(/^([01])(?:\.\d+)?$/);
    if (!match) throw new Error(`Unsupported animation VRM version: ${value}`);
    return match[1];
}

function jsonSourceVrmVersion(json) {
    // Three.js exports may serialize userData as a JSON string.
    const metadata = typeof json.userData === 'string'
        ? JSON.parse(json.userData) : json.userData;
    // The existing unmarked Mixamo/animation-studio clips use VRM 0 coordinates.
    // New exports can declare either version; never infer it from a model name.
    return vrmVersion(metadata?.sourceVrmMetaVersion ?? json.sourceVrmMetaVersion ?? '0');
}

function convertJsonVrmTrack(track, property, sourceVersion, targetVersion) {
    if (sourceVersion === targetVersion) return track;

    const stride = property === 'quaternion' ? 4 : property === 'position' ? 3 : 0;
    for (let i = 0; stride && i < track.values.length; i += stride) {
        track.values[i] *= -1;
        track.values[i + 2] *= -1;
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
function fixHipHeight(track, boneName, property, vrm) {
    if (boneName !== 'hips' || property !== 'position') return track;
    if (track.ValueTypeName !== 'vector') return track; // see note in fixQuaternionContinuity above

    const hipsNode = vrm.humanoid.getNormalizedBoneNode('hips');
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

// Some older exports use normalized node names instead of VRM humanoid bone
// IDs. Resolve those names before asking the target character for a bone.
function jsonBoneName(name) {
    if (!name.startsWith('Normalized_')) return name;
    let legacy = name.slice('Normalized_'.length);
    const side = legacy.endsWith('R') ? 'right' : legacy.endsWith('L') ? 'left' : '';
    if (side) legacy = legacy.slice(0, -1);
    if (legacy === 'thumb_proximal') legacy = 'thumb_metacarpal';
    else if (legacy === 'thumb_intermediate') legacy = 'thumb_proximal';
    const camel = legacy.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
    return side ? side + camel[0].toUpperCase() + camel.slice(1) : camel;
}

// Loads a single animation clip, either:
// - a retargeted Three.js AnimationClip JSON (bone names remapped through
//   vrm.humanoid.getNormalizedBoneNode — canonical VRM bone names only, never
//   internal node names, or clips won't bind on a different three-vrm version)
// - or a .vrma file (VRM animation format, loaded via VRMAnimationLoaderPlugin)
export function loadAnimation(name, filePath, vrmRef, loadedAnimationsRef) {
    // Bind each load to the model that requested it, even if the user switches
    // characters before an animation finishes downloading.
    const vrm = vrmRef.current;
    if (!vrm) return Promise.reject(new Error('Load a VRM before loading animations'));
    if (filePath.split(/[?#]/)[0].toLowerCase().endsWith('.json')) {
        return new Promise((resolve, reject) => {
            fetch(filePath)
                .then(r => {
                    if (r.ok === false) throw new Error(`Could not load ${filePath}: HTTP ${r.status}`);
                    return r.json();
                })
                .then(json => {
                    const sourceVersion = jsonSourceVrmVersion(json);
                    // AnimationClip.parse expects userData to be a serialized
                    // string; consume version metadata ourselves for either form.
                    const rawClip = THREE.AnimationClip.parse({ ...json, userData: undefined });
                    const targetVersion = vrmVersion(vrm.meta.metaVersion);

                    const remappedTracks = rawClip.tracks.map(track => {
                        const [rawBoneName, property] = track.name.split('.');
                        const boneName = jsonBoneName(rawBoneName);
                        const node = vrm.humanoid.getNormalizedBoneNode(boneName);
                        if (!node) {
                            console.warn(`Bone "${boneName}" not found on this VRM — skipping track`);
                            return null;
                        }
                        const clonedTrack = track.clone();
                        clonedTrack.name = `${node.name}.${property}`;
                        convertJsonVrmTrack(clonedTrack, property, sourceVersion, targetVersion);
                        fixQuaternionContinuity(clonedTrack);
                        fixHipHeight(clonedTrack, boneName, property, vrm);
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
                try {
                    const vrmAnimation = gltf.userData.vrmAnimations?.[0];
                    if (!vrmAnimation) throw new Error(`No VRM animation found in ${filePath}`);
                    // VRMA uses VRM 1 coordinates. The library converts them for
                    // the target version and scales hips to the target skeleton.
                    const clip = createVRMAnimationClip(vrmAnimation, vrm);
                    clip.tracks.forEach(fixQuaternionContinuity);
                    loadedAnimationsRef.current[name] = clip;
                    resolve(clip);
                } catch (error) {
                    reject(error);
                }
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
export function getIdleAnimationFiles(character) {
    return IDLE_ANIMATION_FILES
        .map(file => `${ANIMATIONS_BASE_PATH}/${file}`)
        .concat((character?.animations || []).filter(item => item.name.startsWith('idle_')).map(item => item.url));
}

export async function loadAllAnimations({
    character,
    vrmRef,
    loadedAnimationsRef,
    animationsReadyRef,
    playRandomIdle,
    startIdleRotation,
    startFlourishLoop,
    isCurrent = () => true,
}) {
    animationsReadyRef.current = false;
    const custom = character?.animations || [];
    const overrides = new Map(custom.map(item => [item.name, item.url]));
    const idleFiles = getIdleAnimationFiles(character);
    const flourishFiles = IDLE_FLOURISH_FILES.map(file => `${ANIMATIONS_BASE_PATH}/${file}`)
        .concat(custom.filter(item => item.name.startsWith('flourish_')).map(item => item.url));

    const regularLoads = Object.entries(ANIMATION_FILES).map(([name, file]) =>
        loadAnimation(name, overrides.get(name) || `${ANIMATIONS_BASE_PATH}/${file}`, vrmRef, loadedAnimationsRef).catch((e) => {
            console.warn(`❌ Failed to load ${name}:`, e);
            return null;
        })
    );

    const extraLoads = custom.filter(item => !item.name.startsWith('idle_') &&
        !item.name.startsWith('flourish_') && !Object.hasOwn(ANIMATION_FILES, item.name))
        .map(item => loadAnimation(item.name, item.url, vrmRef, loadedAnimationsRef).catch(e => {
            console.warn(`❌ Failed to load ${item.name}:`, e);
            return null;
        }));

    const idleLoads = idleFiles.map((file, i) =>
        loadAnimation(`idle_${i}`, file, vrmRef, loadedAnimationsRef).catch((e) => {
            console.warn(`❌ Failed to load idle_${i}:`, e);
            return null;
        })
    );

    const flourishLoads = flourishFiles.map((file, i) =>
        loadAnimation(`flourish_${i}`, file, vrmRef, loadedAnimationsRef).catch((e) => {
            console.warn(`❌ Failed to load flourish_${i}:`, e);
            return null;
        })
    );

    await Promise.allSettled([...regularLoads, ...extraLoads, ...idleLoads, ...flourishLoads]);
    if (!isCurrent()) return;
    animationsReadyRef.current = Object.keys(loadedAnimationsRef.current).length > 0;
    console.log('✅ Loaded animations:', Object.keys(loadedAnimationsRef.current));

    const loadedIdleKeys = idleFiles
        .map((_, i) => `idle_${i}`)
        .filter(key => loadedAnimationsRef.current[key]);

    const loadedFlourishKeys = flourishFiles
        .map((_, i) => `flourish_${i}`)
        .filter(key => loadedAnimationsRef.current[key]);

    if (loadedIdleKeys.length > 0) {
        playRandomIdle(loadedIdleKeys);
        const stopIdleRotation = startIdleRotation(loadedIdleKeys);
        const stopFlourishLoop = startFlourishLoop(loadedFlourishKeys);
        return () => {
            stopIdleRotation?.();
            stopFlourishLoop?.();
        };
    } else {
        console.warn('⚠️ No idle animations loaded, cannot start idle loop');
    }
}
