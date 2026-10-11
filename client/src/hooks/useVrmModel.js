import { useEffect } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { setupSpringBoneColliders } from '../utils/springBoneColliders';
import { loadAllAnimations } from '../utils/animationLoader';
import { MANUAL_EYE_CLOSING_EXPRESSIONS } from './useExpressions';

const DEFAULT_Y_OFFSET = -0.4;

function disposeVrmScene(vrmScene) {
    vrmScene.traverse((obj) => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) {
            const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
            materials.forEach((mat) => {
                Object.values(mat).forEach((value) => {
                    if (value && value.isTexture) value.dispose();
                });
                mat.dispose();
            });
        }
    });
}

// Loads (and disposes/reloads on character swap) the VRM model itself.
// Everything else — expressions, animation playback — is wired up here
// once the model is ready, via the functions passed in.
export default function useVrmModel({
    character,
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
}) {
    const animationSignature = JSON.stringify(character?.animations || []);
    useEffect(() => {
        const scene = sceneRef.current;
        if (!scene) return;

        if (!character?.modelUrl) {
            if (vrmRef.current) {
                scene.remove(vrmRef.current.scene);
                disposeVrmScene(vrmRef.current.scene);
                vrmRef.current = null;
            }
            loadedAnimationsRef.current = {};
            mixerRef.current = null;
            animationsReadyRef.current = false;
            return;
        }

        // Guards against two loads racing — either from React StrictMode's dev-only
        // double-invoke, or a genuine rapid character swap that starts a second load
        // before the first one finishes. Whichever invocation's cleanup fires first
        // sets its OWN `cancelled` to true; only the surviving (most recent) invocation
        // is allowed to actually wire its result into the shared refs and scene. This
        // is what was causing the intermittent T-pose: without it, a "losing" load's
        // animation clips could end up bound to a skeleton that's no longer the one
        // being rendered, so idle would "play" on a mixer nothing was watching.
        let cancelled = false;
        let stopAnimationLoops;
        let stopBlinking;

        if (vrmRef.current) {
            scene.remove(vrmRef.current.scene);
            disposeVrmScene(vrmRef.current.scene);
            vrmRef.current = null;
        }

        mixerRef.current = null;
        loadedAnimationsRef.current = {};
        currentActionRef.current = null;
        idleActionRef.current = null;
        animationsReadyRef.current = false;
        eyeClosingExpressionsRef.current = [];

        const vrmPath = character.modelUrl;

        const loader = new GLTFLoader();
        loader.register((parser) => new VRMLoaderPlugin(parser));

        loader.load(
            vrmPath,
            (gltf) => {
                const vrm = gltf.userData.vrm;

                if (cancelled) {
                    // Superseded by a newer invocation — dispose what we just loaded
                    // instead of touching any shared state or the scene.
                    disposeVrmScene(vrm.scene);
                    return;
                }

                VRMUtils.rotateVRM0(vrm);

                // The original face used stylized shading that glTF's plain PBR
                // material cannot carry. Restore a little contour on its skin
                // without changing lighting or materials elsewhere in the scene.
                if (character.modelName.toLowerCase().startsWith('hsin_')) {
                    vrm.scene.traverse((obj) => {
                        if (!obj.isMesh || !/^VRM_Face[ _](Default|Enhanced)/.test(obj.name)) return;
                        const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
                        materials.filter((mat) => mat?.name.includes('GS_Face')).forEach((mat) => {
                            const originalCompile = mat.onBeforeCompile;
                            mat.onBeforeCompile = (shader, renderer) => {
                                originalCompile.call(mat, shader, renderer);
                                const marker = '#include <normal_fragment_maps>';
                                shader.fragmentShader = shader.fragmentShader.replace(
                                    marker,
                                    `${marker}\n diffuseColor.rgb *= 0.78 + 0.22 * max(dot(normal, normalize(vec3(-0.45, 0.25, 0.86))), 0.0);`
                                );
                            };
                            mat.customProgramCacheKey = () => 'hsin-face-contour-v1';
                            mat.needsUpdate = true;
                        });
                    });
                }

                vrmRef.current = vrm;
                vrm.scene.position.y = DEFAULT_Y_OFFSET;
                setupSpringBoneColliders(vrm);
                scene.add(vrm.scene);

                console.log('VRM loaded:', character.name);

                const detected = getEyeClosingExpressionNames(vrm);
                eyeClosingExpressionsRef.current = [...new Set([...detected, ...MANUAL_EYE_CLOSING_EXPRESSIONS])];
                console.log('Eye-closing expressions (auto + manual):', eyeClosingExpressionsRef.current);

                mixerRef.current = new THREE.AnimationMixer(vrm.humanoid.normalizedHumanBonesRoot);

                const animationsForModel = { current: loadedAnimationsRef.current };
                const vrmForAnimations = { current: vrm };
                loadAllAnimations({
                    character,
                    vrmRef: vrmForAnimations,
                    loadedAnimationsRef: animationsForModel,
                    animationsReadyRef,
                    playRandomIdle,
                    startIdleRotation,
                    startFlourishLoop,
                    isCurrent: () => !cancelled && loadedAnimationsRef.current === animationsForModel.current,
                }).then(stop => {
                    if (cancelled) stop?.();
                    else stopAnimationLoops = stop;
                }).catch(error => console.error('Could not load character animations:', error));

                console.log('Starting blink loop...');
                stopBlinking = startBlinking();
            },
            (progress) => {
                console.log('Loading VRM:', Math.round((progress.loaded / progress.total) * 100) + '%');
            },
            (error) => {
                console.error('Error loading VRM:', error);
            }
        );

        return () => {
            cancelled = true;
            stopAnimationLoops?.();
            stopBlinking?.();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [character?.modelUrl, animationSignature]);
}
