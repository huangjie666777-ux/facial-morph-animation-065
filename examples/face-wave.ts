import { AnimationMixer, Matrix4, Vector3 } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  Skeleton,
  evaluatePose,
  evaluateTriangleMesh,
  exportCharacterGlb,
  sampleMorphWeights,
  type AnimationClip,
  type SkinInfluence,
  type TriangleMesh,
  type Vec3,
} from '../src/index.js';
import { humanoidBones, walkClip, waveClip } from '../test/helpers.js';

const skeleton = new Skeleton(humanoidBones());
const positions: Vec3[] = [
  [-0.08, 1.49, 0.02],
  [0.08, 1.49, 0.02],
  [0, 1.45, 0.02],
  [-0.08, 1.57, 0.02],
  [0.08, 1.57, 0.02],
];
const skinWeights: SkinInfluence[][] = positions.map(() => [{ boneId: 'head', weight: 1 }]);
const zero: Vec3 = [0, 0, 0];
const mesh: TriangleMesh = {
  name: 'face-mesh',
  positions,
  indices: [0, 1, 2, 3, 4, 2],
  weights: skinWeights,
  morphTargets: [
    {
      name: 'smile',
      displacements: [
        [-0.025, -0.012, 0], [0.025, -0.012, 0], zero, zero, zero,
      ],
    },
    {
      name: 'blink',
      displacements: [
        zero, zero, zero, [0, -0.025, 0], [0, -0.025, 0],
      ],
    },
    {
      name: 'mouth-open',
      displacements: [zero, zero, [0, -0.04, 0.01], zero, zero],
    },
    {
      name: 'brow-rest',
      defaultWeight: 0.2,
      displacements: [[0, 0.006, 0], [0, 0.006, 0], zero, zero, zero],
    },
  ],
};

const walk = walkClip();
const faceWalk: AnimationClip = {
  name: 'face-walk-wave',
  duration: walk.duration,
  tracks: walk.tracks,
  morphTracks: [
    { targetName: 'smile', keys: [
      { time: 0, value: 0.25 }, { time: 0.5, value: 1 }, { time: 1, value: 0.75 },
    ] },
    { targetName: 'blink', keys: [
      { time: 0.1, value: 0 }, { time: 0.2, value: 1 },
      { time: 0.8, value: 1 }, { time: 0.9, value: 0 },
    ] },
    { targetName: 'mouth-open', keys: [
      { time: 0.15, value: 0 }, { time: 0.35, value: 0.9 },
      { time: 0.65, value: 0.2 }, { time: 0.85, value: 0.9 },
    ] },
  ],
};
const faceOnly: AnimationClip = {
  name: 'face-only',
  duration: 1.2,
  tracks: [],
  morphTracks: [
    { targetName: 'smile', keys: [{ time: 0, value: 0.2 }, { time: 1.2, value: 0.9 }] },
    { targetName: 'mouth-open', keys: [{ time: 0.3, value: 0.1 }, { time: 0.9, value: 0.8 }] },
  ],
};

const time = 1.3;
const pose = evaluatePose(
  skeleton,
  { clip: faceWalk, time, loop: 'loop' },
  { clip: waveClip(), time, loop: 'loop', strength: 1, mask: { 'arm.R': 1 } },
);
const cpuVertices = evaluateTriangleMesh(skeleton, mesh, faceWalk, time, 'loop', pose.worldMatrices);
const weights = sampleMorphWeights(faceWalk, mesh.morphTargets ?? [], time, 'loop');

console.log('=== 表情权重 t=' + time + 's（循环到 0.3s）===');
['smile', 'blink', 'mouth-open', 'brow-rest'].forEach((name, i) => {
  console.log(name.padEnd(11), weights[i].toFixed(4));
});
console.log('\n=== CPU 先形变后蒙皮 ===');
cpuVertices.forEach((vertex, i) => console.log('v' + i, vertex.map((n) => n.toFixed(5)).join(', ')));

const glb = exportCharacterGlb({ skeleton, mesh, clips: [faceWalk, faceOnly] });
const gltf = await new Promise<any>((resolve, reject) => {
  new GLTFLoader().parse(glb.slice(0), '', resolve, reject);
});
const skinned = gltf.scene.children.find((child: any) => child.isSkinnedMesh);
if (!skinned) throw new Error('回载资产缺少 SkinnedMesh');

const mixer = new AnimationMixer(gltf.scene);
const action = mixer.clipAction(gltf.animations[0]);
action.play();
mixer.update(0.3);
gltf.scene.updateMatrixWorld(true);
skinned.skeleton.update();

let maxError = 0;
for (let vertexIndex = 0; vertexIndex < positions.length; vertexIndex++) {
  const morphed = new Vector3(...positions[vertexIndex]);
  skinned.geometry.morphAttributes.position.forEach((attribute: any, targetIndex: number) => {
    morphed.addScaledVector(
      new Vector3(attribute.getX(vertexIndex), attribute.getY(vertexIndex), attribute.getZ(vertexIndex)),
      skinned.morphTargetInfluences[targetIndex],
    );
  });
  const loaded = new Vector3();
  for (let slot = 0; slot < 4; slot++) {
    const componentIndex = vertexIndex * 4 + slot;
    const joint = skinned.geometry.attributes.skinIndex.array[componentIndex] as number;
    const jointWeight = skinned.geometry.attributes.skinWeight.array[componentIndex] as number;
    if (jointWeight === 0) continue;
    const matrix = new Matrix4().fromArray(
      Array.from(skinned.skeleton.boneMatrices.slice(joint * 16, joint * 16 + 16)),
    );
    loaded.addScaledVector(morphed.clone().applyMatrix4(matrix), jointWeight);
  }
  maxError = Math.max(
    maxError,
    Math.abs(loaded.x - cpuVertices[vertexIndex][0]),
    Math.abs(loaded.y - cpuVertices[vertexIndex][1]),
    Math.abs(loaded.z - cpuVertices[vertexIndex][2]),
  );
}
if (maxError > 1e-5) throw new Error('GLTFLoader 回载结果与 CPU 不一致: ' + maxError);
console.log('\nGLTFLoader 回载验证通过，最大误差:', maxError.toExponential());
console.log('保留片段:', gltf.animations.map((clip: any) => clip.name + '@' + clip.duration.toFixed(1)).join(', '));
