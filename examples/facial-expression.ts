/**
 * 表情形变与身体骨骼动画共用同一个片段时钟：
 * 行走骨骼轨道 + smile/blink/mouth-a 权重轨道同时播放，
 * CPU 先叠加 morph displacement，再执行当前混合/IK 姿态蒙皮；
 * 最后导出 GLB 并用 Three.js GLTFLoader 回载比较。
 */
import { AnimationMixer, LoopRepeat, Matrix4, Vector3 } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  Skeleton,
  computeWorldMatrices,
  evaluatePose,
  exportCharacterGlb,
  sampleClip,
  sampleMorphWeights,
  skinMorphedVertices,
  solveTwoBoneIk,
  type SkinInfluence,
  type TriangleMesh,
  type Vec3,
} from '../src/index.js';
import { humanoidBones, walkClip, waveClip } from '../test/helpers.js';

const skeleton = new Skeleton(humanoidBones());
const positions: Vec3[] = [
  [0.08, 1.58, 0.04],
  [-0.08, 1.58, 0.04],
  [0, 1.51, 0.08],
  [0.18, 1.48, 0],
];
const weights: SkinInfluence[][] = [
  [{ boneId: 'head', weight: 1 }],
  [{ boneId: 'head', weight: 1 }],
  [{ boneId: 'head', weight: 1 }],
  [{ boneId: 'spine', weight: 0.7 }, { boneId: 'arm.R', weight: 0.3 }],
];
const targets = [
  {
    name: 'smile',
    displacements: [[0.02, -0.01, 0], [-0.02, -0.01, 0], [0, 0.03, 0], [0, 0, 0]] as Vec3[],
  },
  {
    name: 'blink',
    defaultWeight: 0,
    displacements: [[0, -0.015, 0], [0, -0.015, 0], [0, 0, 0], [0, 0, 0]] as Vec3[],
  },
  {
    name: 'mouth-a',
    displacements: [[0, 0, 0], [0, 0, 0], [0, 0.06, 0], [0, 0, 0]] as Vec3[],
  },
];
const mesh: TriangleMesh = { name: 'facial-expression', positions, indices: [0, 1, 2, 0, 2, 3], weights, targets };

const walkFace = {
  ...walkClip(),
  name: 'walk-face',
  morphTracks: [
    { targetName: 'smile', keys: [{ time: 0, value: 0.1 }, { time: 0.5, value: 1 }, { time: 1, value: 0.1 }] },
    { targetName: 'blink', keys: [{ time: 0, value: 0 }, { time: 0.1, value: 1 }, { time: 0.2, value: 0 }, { time: 1, value: 0 }] },
    { targetName: 'mouth-a', keys: [{ time: 0, value: 0.2 }, { time: 0.25, value: 1 }, { time: 0.5, value: 0.1 }, { time: 1, value: 0.2 }] },
  ],
};
const wave = waveClip();
const TIME = 1.7; // walk-face 循环到 0.7s；wave 循环到 0.1s。

const pose = evaluatePose(
  skeleton,
  { clip: walkFace, time: TIME, loop: 'loop' },
  { clip: wave, time: TIME, loop: 'loop', strength: 1, mask: { 'arm.R': 1 } },
);
const morphWeights = sampleMorphWeights(walkFace, targets, TIME, 'loop');
const mixedVertices = skinMorphedVertices(skeleton, mesh, weights, pose.worldMatrices, morphWeights);
const ik = solveTwoBoneIk(skeleton, pose.localPose, {
  rootJointId: 'spine',
  middleJointId: 'arm.R',
  endJointId: 'hand.R',
  target: [0.52, 1.16, 0.18],
  bendReference: [0.18, 1.65, 0.08],
  weight: 1,
});
const ikVertices = skinMorphedVertices(skeleton, mesh, weights, ik.worldMatrices, morphWeights);

const fmt = (v: readonly number[]) => v.map((n) => n.toFixed(5)).join(', ');
console.log('=== 表情权重（与身体动作共用 t=' + TIME + 's） ===');
for (const [name, weight] of morphWeights) console.log(name.padEnd(8), weight.toFixed(4));
console.log('\n=== CPU：先表情形变，再混合/IK 姿态蒙皮 ===');
mixedVertices.forEach((v, i) => console.log('v' + i, '混合 [' + fmt(v) + ']  IK [' + fmt(ikVertices[i]) + ']'));

const glb = exportCharacterGlb({ skeleton, mesh, clips: [walkFace] });
const gltf = await new Promise<any>((resolve, reject) => {
  new GLTFLoader().parse(glb.slice(0), '', resolve, reject);
});
const mixer = new AnimationMixer(gltf.scene);
const action = mixer.clipAction(gltf.animations[0]);
action.setLoop(LoopRepeat, Infinity);
action.play();
mixer.update(0.7);
gltf.scene.updateMatrixWorld(true);
const skinned = gltf.scene.children.find((child: any) => child.isSkinnedMesh);
skinned.skeleton.update();

const expected = skinMorphedVertices(
  skeleton,
  mesh,
  weights,
  computeWorldMatrices(skeleton, sampleClip(walkFace, skeleton, 0.7, 'loop')),
  sampleMorphWeights(walkFace, targets, 0.7, 'loop'),
);
let maxError = 0;
for (let i = 0; i < positions.length; i++) {
  const base = new Vector3(...positions[i]);
  skinned.morphTargetInfluences.forEach((influence: number, targetIndex: number) => {
    const d = targets[targetIndex].displacements[i];
    base.addScaledVector(new Vector3(...d), influence);
  });
  const actual = new Vector3();
  for (let slot = 0; slot < 4; slot++) {
    const index = i * 4 + slot;
    const weightValue = skinned.geometry.attributes.skinWeight.array[index] as number;
    if (weightValue === 0) continue;
    const joint = skinned.geometry.attributes.skinIndex.array[index] as number;
    const matrix = new Matrix4().fromArray(
      Array.from(skinned.skeleton.boneMatrices.slice(joint * 16, joint * 16 + 16)),
    );
    actual.addScaledVector(base.clone().applyMatrix4(matrix), weightValue);
  }
  maxError = Math.max(
    maxError,
    Math.abs(actual.x - expected[i][0]),
    Math.abs(actual.y - expected[i][1]),
    Math.abs(actual.z - expected[i][2]),
  );
}
console.log('\nGLTFLoader 回载形变+骨骼动画最大误差:', maxError.toExponential(3));
if (maxError > 1e-5) throw new Error('GLB 回载结果与库内 CPU 求值不一致');
console.log('GLB morph targets:', skinned.morphTargetDictionary);
