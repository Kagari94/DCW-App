import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

// Owns the Three.js scene, camera, renderer, controls, lights, resize handling,
// and the main render loop (mixer.update -> vrm.update -> controls.update -> render).
// Knows nothing about VRM loading — just the scene graph and render loop.
// mixerRef/vrmRef are read each frame via refs so this effect never needs to
// re-run when the model or animations change.
export default function useThreeScene({ mixerRef, vrmRef, lighting }) {
    const mountRef = useRef(null);
    const sceneRef = useRef(null);
    const lightsRef = useRef({});

    // Apply lighting prop changes to existing lights
    useEffect(() => {
        if (!lighting) return;
        const lights = lightsRef.current;

        Object.entries(lighting).forEach(([name, { color, intensity }]) => {
            const light = lights[name];
            if (light) {
                light.color.set(color);
                light.intensity = intensity;
            }
        });
    }, [lighting]);

    // One-time scene setup (runs once on mount only)
    useEffect(() => {
        const mount = mountRef.current;

        const scene = new THREE.Scene();
        scene.background = null;
        sceneRef.current = scene;

        const camera = new THREE.PerspectiveCamera(
            10,
            mount.clientWidth / mount.clientHeight,
            0.1,
            100
        );
        camera.position.set(0, 1.5, 4);
        camera.lookAt(0, 1, 0);

        const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
        renderer.setSize(mount.clientWidth, mount.clientHeight);
        mount.appendChild(renderer.domElement);

        const controls = new OrbitControls(camera, renderer.domElement);
        controls.target.set(0, 1, 0);
        controls.enableDamping = true;
        controls.dampingFactor = 0.08;
        controls.minDistance = 1;
        controls.maxDistance = 10;
        controls.update();

        const keyLight = new THREE.DirectionalLight(0xffd5aa, 1.2);
        keyLight.position.set(-3, 2.5, 4);
        keyLight.castShadow = true;
        scene.add(keyLight);

        const fillLight = new THREE.DirectionalLight(0xaaaaff, 0.6);
        fillLight.position.set(4, 2, 4);
        scene.add(fillLight);

        const rimLight = new THREE.DirectionalLight(0x8888aa, 0.6);
        rimLight.position.set(0, 4, 2);
        scene.add(rimLight);

        const ambientLight = new THREE.AmbientLight(0x404040, 0.4);
        scene.add(ambientLight);

        lightsRef.current = { key: keyLight, fill: fillLight, rim: rimLight, ambient: ambientLight };

        function handleResize() {
            camera.aspect = mount.clientWidth / mount.clientHeight;
            camera.updateProjectionMatrix();
            renderer.setSize(mount.clientWidth, mount.clientHeight);
        }
        window.addEventListener('resize', handleResize);

        const timer = new THREE.Timer();
        let frameId;

        function animate() {
            frameId = requestAnimationFrame(animate);
            timer.update();
            const delta = timer.getDelta();
            if (mixerRef.current) mixerRef.current.update(delta);
            if (vrmRef.current) vrmRef.current.update(delta);
            controls.update();
            renderer.render(scene, camera);
        }
        animate();

        return () => {
            cancelAnimationFrame(frameId);
            window.removeEventListener('resize', handleResize);
            controls.dispose();
            mount.removeChild(renderer.domElement);
            renderer.dispose();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return { mountRef, sceneRef };
}
