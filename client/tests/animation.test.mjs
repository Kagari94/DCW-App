import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMAnimationLoaderPlugin } from '@pixiv/three-vrm-animation';
import { ANIMATION_FILES, getIdleAnimationFiles, loadAllAnimations, loadAnimation } from '../src/utils/animationLoader.js';

function targetVrm(version, prefix = '') {
    return {
        meta: { metaVersion: version },
        humanoid: {
            normalizedRestPose: { hips: { position: [0, 0.9, 0] } },
            getNormalizedBoneNode: name => ({ name: `${prefix}${name}`, position: { y: 0.9 } }),
        },
        expressionManager: null,
        lookAt: null,
    };
}

function armDirection(track, version) {
    // The right arm points along +X in a VRM 0 T-pose and -X in VRM 1.
    return new THREE.Vector3(version === '0' ? 1 : -1, 0, 0)
        .applyQuaternion(new THREE.Quaternion().fromArray(track.values));
}

test('all models use the configured idle pool without an Hsin dependency', () => {
    const files = getIdleAnimationFiles({ modelName: 'AnotherModel.vrm', animations: [] });
    assert.deepEqual(files, [
        '/animations/idle_1.json', '/animations/idle_2.json',
        '/animations/idle_3.json', '/animations/standinlook.vrma',
    ]);
    assert.deepEqual(getIdleAnimationFiles({ modelName: 'Hsin_Final_Default.vrm' }), files);
    assert.ok(Object.values(ANIMATION_FILES).every(file => !file.includes('Hsin')));
});

test('bundled JSON idles lower the arms on both VRM versions and map legacy names', async () => {
    const originalFetch = globalThis.fetch;
    const clips = new Map();
    for (const file of ['idle_1.json', 'idle_2.json', 'idle_3.json']) {
        clips.set(file, JSON.parse(await readFile(new URL(`../public/animations/${file}`, import.meta.url), 'utf8')));
    }
    globalThis.fetch = async path => ({ json: async () => clips.get(path.split('/').at(-1)) });
    try {
        for (const version of ['0', '1']) {
            const vrmRef = { current: targetVrm(version) };
            const loaded = { current: {} };
            for (const file of clips.keys()) {
                const clip = await loadAnimation(file, `/animations/${file}`, vrmRef, loaded);
                assert.equal(clip.tracks.length, 53, `${file} lost bone tracks`);
                const arm = clip.tracks.find(track => track.name === 'rightUpperArm.quaternion');
                assert.ok(armDirection(arm, version).y < -0.5, `${file} raised the arm on VRM ${version}`);
            }
            const leftArm = name => loaded.current[name].tracks.find(track => track.name === 'leftUpperArm.quaternion');
            assert.deepEqual([...leftArm('idle_1.json').values], [...leftArm('idle_2.json').values]);
        }
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('JSON converts either source version once and keeps its source data intact', async () => {
    const originalFetch = globalThis.fetch;
    try {
        for (const sourceVersion of ['0', '1']) {
            const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.2, 0.1, sourceVersion === '0' ? -1 : 1));
            const bend = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), sourceVersion === '0' ? -0.4 : 0.4);
            for (const metadata of [
                { sourceVrmMetaVersion: Number(sourceVersion) },
                JSON.stringify({ sourceVrmMetaVersion: `${sourceVersion}.0` }),
            ]) {
                const json = {
                    name: 'gesture', duration: 1, userData: metadata,
                    tracks: [
                        { name: 'rightUpperArm.quaternion', type: 'quaternion', times: [0, 1],
                            values: [...q.toArray(), ...q.toArray().map(value => -value)] },
                        { name: 'hips.position', type: 'vector', times: [0, 1], values: [0.2, 1, 0.3, 0.4, 1.1, 0.5] },
                        ...['head', 'rightLowerLeg'].map(bone => ({ name: `${bone}.quaternion`, type: 'quaternion',
                            times: [0], values: bend.toArray() })),
                    ],
                };
                const saved = structuredClone(json);
                globalThis.fetch = async () => ({ ok: true, json: async () => json });
                for (const targetVersion of ['0', '1']) {
                    const clip = await loadAnimation('gesture', '/gesture.JSON?revision=2',
                        { current: targetVrm(targetVersion, `model${targetVersion}_`) }, { current: {} });
                    const arm = clip.tracks.find(track => track.name.endsWith('quaternion'));
                    assert.ok(armDirection(arm, targetVersion).y < -0.5);
                    const first = new THREE.Quaternion().fromArray(arm.values);
                    const second = new THREE.Quaternion().fromArray(arm.values, 4);
                    assert.ok(first.dot(second) > 0.99, 'quaternion interpolation changed direction');
                    const hips = clip.tracks.find(track => track.name.endsWith('position'));
                    const sign = targetVersion === sourceVersion ? 1 : -1;
                    assert.ok(Math.abs(hips.values[0] - sign * 0.2) < 1e-6);
                    assert.ok(Math.abs(hips.values[2] - sign * 0.3) < 1e-6);
                    assert.ok(Math.abs(hips.values[1] - 0.9) < 1e-6);
                    assert.ok(Math.abs(hips.values[4] - 1.0) < 1e-6);
                    const forward = targetVersion === '0' ? -1 : 1;
                    const head = clip.tracks.find(track => track.name.endsWith('head.quaternion'));
                    const gaze = new THREE.Vector3(0, 0, forward)
                        .applyQuaternion(new THREE.Quaternion().fromArray(head.values));
                    assert.ok(gaze.y < -0.3, 'look-down animation looked up');
                    const knee = clip.tracks.find(track => track.name.endsWith('rightLowerLeg.quaternion'));
                    const shin = new THREE.Vector3(0, -1, 0)
                        .applyQuaternion(new THREE.Quaternion().fromArray(knee.values));
                    assert.ok(shin.z * forward < -0.3, 'knee bent forward instead of folding the shin behind');
                }
                assert.deepEqual(json, saved);
            }
        }
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('an in-flight animation stays bound to the model that requested it', async () => {
    const originalFetch = globalThis.fetch;
    let finishFetch;
    globalThis.fetch = () => new Promise(resolve => { finishFetch = resolve; });
    try {
        const vrmRef = { current: targetVrm('0', 'first_') };
        const pending = loadAnimation('gesture', '/gesture.json', vrmRef, { current: {} });
        vrmRef.current = targetVrm('1', 'second_');
        finishFetch({ ok: true, json: async () => ({ name: 'gesture', duration: 1,
            tracks: [{ name: 'head.quaternion', type: 'quaternion', times: [0], values: [0.1, 0, 0, Math.sqrt(0.99)] }],
        }) });
        const clip = await pending;
        assert.equal(clip.tracks[0].name, 'first_head.quaternion');
        assert.ok(clip.tracks[0].values[0] > 0);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('VRMA uses the library conversion for both model versions without an extra flip', async () => {
    const bytes = await readFile(new URL('../public/animations/Greeting.vrma', import.meta.url));
    const loader = new GLTFLoader();
    loader.register(parser => new VRMAnimationLoaderPlugin(parser));
    const gltf = await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
    const source = gltf.userData.vrmAnimations[0];
    const sourceValues = [...source.humanoidTracks.rotation.get('rightUpperArm').values];
    const originalLoad = GLTFLoader.prototype.load;
    GLTFLoader.prototype.load = function (_path, onLoad) { onLoad(gltf); };
    try {
        for (const version of ['0', '1']) {
            const clip = await loadAnimation('greeting', '/Greeting.vrma', { current: targetVrm(version) }, { current: {} });
            const arm = clip.tracks.find(track => track.name === 'rightUpperArm.quaternion');
            assert.ok(armDirection(arm, version).y < -0.5);
            const hips = clip.tracks.find(track => track.name === 'hips.position');
            const sourceHips = source.humanoidTracks.translation.get('hips');
            const scale = 0.9 / source.restHipsPosition.y;
            assert.ok(Math.abs(hips.values[0] - sourceHips.values[0] * scale * (version === '0' ? -1 : 1)) < 1e-6);
        }
        assert.deepEqual([...source.humanoidTracks.rotation.get('rightUpperArm').values], sourceValues);
    } finally {
        GLTFLoader.prototype.load = originalLoad;
    }
});

test('a deleted animation is skipped while the remaining idle still starts', async () => {
    const originalFetch = globalThis.fetch;
    const originalLoad = GLTFLoader.prototype.load;
    const originalWarn = console.warn;
    let finishFetch;
    globalThis.fetch = path => path === '/animations/idle_1.json'
        ? new Promise(resolve => { finishFetch = resolve; })
        : Promise.resolve({ ok: false, status: 404 });
    GLTFLoader.prototype.load = function (_path, _onLoad, _progress, onError) { onError(new Error('File removed')); };
    console.warn = () => {};
    try {
        const ready = { current: true };
        const loaded = { current: {} };
        let started;
        let stopped = 0;
        const pending = loadAllAnimations({
            character: { modelName: 'Shinji.vrm', animations: [] }, vrmRef: { current: targetVrm('1') },
            loadedAnimationsRef: loaded, animationsReadyRef: ready,
            playRandomIdle: keys => { assert.equal(ready.current, true); started = keys; },
            startIdleRotation: () => () => { stopped += 1; },
            startFlourishLoop: () => () => { stopped += 1; },
        });
        assert.equal(ready.current, false);
        finishFetch({ ok: true, json: async () => ({ name: 'idle', duration: 1,
            tracks: [{ name: 'head.quaternion', type: 'quaternion', times: [0], values: [0, 0, 0, 1] }],
        }) });
        const stop = await pending;
        assert.deepEqual(started, ['idle_0']);
        assert.deepEqual(Object.keys(loaded.current), ['idle_0']);
        stop();
        assert.equal(stopped, 2);
    } finally {
        globalThis.fetch = originalFetch;
        GLTFLoader.prototype.load = originalLoad;
        console.warn = originalWarn;
    }
});
