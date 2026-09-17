import * as THREE from 'three';
import { VRMSpringBoneColliderShapeSphere, VRMSpringBoneCollider } from '@pixiv/three-vrm';

const COLLIDER_DEFS = [
    ['head', 0.06, 0.0, 0.08],
    ['neck', 0.0, 0.0, 0.06],
    ['chest', 0.0, 0.05, 0.14],
    ['spine', 0.0, 0.03, 0.12],
    ['hips', 0.0, 0.03, 0.12],
    ['leftUpperArm', 0.0, 0.0, 0.05],
    ['rightUpperArm', 0.0, 0.0, 0.05],
    ['leftLowerArm', 0.0, 0.0, 0.04],
    ['rightLowerArm', 0.0, 0.0, 0.04],
    ['leftUpperLeg', 0.0, 0.0, 0.07],
    ['rightUpperLeg', 0.0, 0.0, 0.07],
];

export function setupSpringBoneColliders(vrm) {
    if (!vrm.springBoneManager) return;

    const colliders = [];

    for (const [boneName, offsetY, offsetZ, radius] of COLLIDER_DEFS) {
        const bone = vrm.humanoid?.getNormalizedBoneNode(boneName);
        if (!bone) continue;

        const shape = new VRMSpringBoneColliderShapeSphere({
            offset: new THREE.Vector3(0, offsetY, offsetZ),
            radius,
        });

        const collider = new VRMSpringBoneCollider({ shape });
        bone.add(collider);
        colliders.push(collider);
    }

    vrm.springBoneManager.colliderGroups.push({
        node: vrm.scene,
        colliders,
    });
}
