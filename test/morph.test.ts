import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnimationMixer, LoopOnce, Matrix4, Vector3 } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  Skeleton,
  applyMorphTargets,
  computeWorldMatrices,
  evaluateTriangleMesh,
  exportCharacterGlb,
  sampleClip,
  sampleMorphWeights,
  skinTriangleMesh,
  type AnimationClip,
  type SkinInfluence,
  type TriangleMesh,
  type Vec3,
} from '../src/index.js';
import { humanoidBones, walkClip } from './helpers.js';

const sk = new Skeleton(humanoidBones());
const positions: Vec3[] = [[0, 1.5, 0], [0.1, 1.45, 0]];
const weights: SkinInfluence[][] = [
  [{ boneId: 'head', weight: 1 }],
  [{ boneId: 'head', weight: 1 }],
];
const mesh: TriangleMesh = {
  name: 'face',
  positions,
  indices: [0, 1, 0],
  weights,
  morphTargets: [
    { name: 'smile', displacements: [[0, 0.1, 0], [0.1, 0, 0]] },
    { name: 'blink', defaultWeight: 0.25, displacements: [[0, 0, 0.2], [0, 0, 0.3]] },
  ],
};

function parseGlb(buffer: ArrayBuffer): Promise<any> {
  return new Promise((resolve, reject) => {
    new GLTFLoader().parse(buffer, '', resolve, reject);
  });
}

test('形变目标按独立权重叠加且缺失轨道使用默认值', () => {
  const clip: AnimationClip = {
    name: 'face',
    duration: 1,
    tracks: [],
    morphTracks: [
      { targetName: 'smile', keys: [{ time: 0.2, value: 0.2 }, { time: 0.8, value: 0.8 }] },
    ],
  };
  const sampled = sampleMorphWeights(clip, mesh.morphTargets ?? [], 0.5, 'once');
  assert.deepEqual(sampled, [0.5, 0.25]);
  const morphed = applyMorphTargets(mesh, sampled);
  assert.ok(Math.abs(morphed[0][1] - 1.55) < 1e-7);
  assert.ok(Math.abs(morphed[0][2] - 0.05) < 1e-7);
  assert.ok(Math.abs(morphed[1][0] - 0.15) < 1e-7);
  assert.ok(Math.abs(morphed[1][2] - 0.075) < 1e-7);
  assert.deepEqual(positions, mesh.positions);
});

test('once 末帧保持最后表情权重，loop 在片段内循环', () => {
  const clip: AnimationClip = {
    name: 'last',
    duration: 1,
    tracks: [],
    morphTracks: [{ targetName: 'smile', keys: [
      { time: 0, value: 0 }, { time: 0.5, value: 0.5 }, { time: 1, value: 0.8 },
    ] }],
  };
  assert.equal(sampleMorphWeights(clip, mesh.morphTargets ?? [], 1, 'once')[0], 0.8);
  assert.equal(sampleMorphWeights(clip, mesh.morphTargets ?? [], 1.5, 'once')[0], 0.8);
  assert.equal(sampleMorphWeights(clip, mesh.morphTargets ?? [], 1.5, 'loop')[0], 0.5);
});

test('CPU 先叠加表情位移再执行当前骨骼姿态蒙皮', () => {
  const pose = sampleClip(walkClip(), sk, 0.25, 'loop');
  const worldMatrices = computeWorldMatrices(sk, pose);
  const clip: AnimationClip = {
    name: 'face-walk',
    duration: 1,
    tracks: walkClip().tracks,
    morphTracks: [{ targetName: 'blink', keys: [{ time: 0, value: 1 }, { time: 1, value: 1 }] }],
  };
  const out = evaluateTriangleMesh(sk, mesh, clip, 0.25, 'loop', worldMatrices);
  const expected = skinTriangleMesh(sk, mesh, worldMatrices, [0, 1]);
  assert.deepEqual(out, expected);
  const headMatrix = new Matrix4().multiplyMatrices(worldMatrices.get('head')!, sk.inverseBindMatrix('head'));
  const expectedVertex = new Vector3(0, 1.5, 0.2).applyMatrix4(headMatrix);
  assert.ok(Math.abs(out[0][0] - expectedVertex.x) < 1e-12);
  assert.ok(Math.abs(out[0][1] - expectedVertex.y) < 1e-12);
});

test('拒绝重复或未知目标、顶点数不符、非法位移、默认值、时间和权重', () => {
  assert.throws(() => applyMorphTargets(
    { ...mesh, morphTargets: [mesh.morphTargets![0], mesh.morphTargets![0]] },
    [0, 0],
  ), /重复/);
  assert.throws(() => sampleMorphWeights(
    { name: 'x', duration: 1, tracks: [], morphTracks: [{ targetName: 'ghost', keys: [{ time: 0, value: 0 }] }] },
    mesh.morphTargets ?? [], 0, 'once',
  ), /未知形变目标/);
  assert.throws(() => applyMorphTargets(
    { ...mesh, morphTargets: [{ name: 'x', displacements: [[0, 0, 0]] }] },
    [0],
  ), /位移数与顶点数不一致/);
  assert.throws(() => applyMorphTargets(
    { ...mesh, morphTargets: [{ name: 'x', displacements: [[Number.NaN, 0, 0], [0, 0, 0]] }] },
    [0],
  ), /非法数值/);
  assert.throws(() => applyMorphTargets(
    { ...mesh, morphTargets: [{ name: 'x', defaultWeight: 2, displacements: mesh.morphTargets![0].displacements }] },
    [0],
  ), /默认权重/);
  assert.throws(() => sampleMorphWeights(
    { name: 'x', duration: 1, tracks: [], morphTracks: [{ targetName: 'smile', keys: [{ time: 1.2, value: 0 }] }] },
    mesh.morphTargets ?? [], 0, 'once',
  ), /超出片段范围/);
  assert.throws(() => sampleMorphWeights(
    { name: 'x', duration: 1, tracks: [], morphTracks: [{ targetName: 'smile', keys: [{ time: 0.5, value: 1.2 }] }] },
    mesh.morphTargets ?? [], 0, 'once',
  ), /权重必须/);
});

test('拒绝会在 Float32 中溢出的有限坐标', () => {
  const overflowMesh: TriangleMesh = {
    ...mesh,
    positions: [[1e39, 0, 0], positions[1]],
  };
  assert.throws(
    () => exportCharacterGlb({ skeleton: sk, mesh: overflowMesh, clips: [] }),
    /FLOAT32/,
  );
});

test('GLB 保留目标顺序名称默认权重、时长，并用 GLTFLoader 同步回载', async () => {
  const clip: AnimationClip = {
    name: 'face-walk',
    duration: 1,
    tracks: walkClip().tracks,
    morphTracks: [
      { targetName: 'smile', keys: [{ time: 0.1, value: 0.1 }, { time: 0.7, value: 0.9 }] },
      { targetName: 'blink', keys: [
        { time: 0.2, value: 0 }, { time: 0.3, value: 1 }, { time: 0.8, value: 0.5 },
      ] },
    ],
  };
  const faceOnly: AnimationClip = {
    name: 'face-only',
    duration: 1.25,
    tracks: [],
    morphTracks: [{ targetName: 'smile', keys: [{ time: 0, value: 0 }, { time: 1.25, value: 1 }] }],
  };
  const buffer = exportCharacterGlb({ skeleton: sk, mesh, clips: [clip, faceOnly] });
  const json = JSON.parse(Buffer.from(buffer, 20, new DataView(buffer).getUint32(12, true)).toString('utf8'));
  assert.deepEqual(json.meshes[0].extras.targetNames, ['smile', 'blink']);
  assert.deepEqual(json.meshes[0].weights, [0, 0.25]);
  assert.equal(json.meshes[0].primitives[0].targets.length, 2);
  assert.equal(json.animations[1].samplers[0].input !== undefined, true);

  const gltf = await parseGlb(buffer.slice(0));
  assert.equal(gltf.animations[1].duration, 1.25);
  const skinned = gltf.scene.children.find((child: any) => child.isSkinnedMesh);
  assert.deepEqual(Object.keys(skinned.morphTargetDictionary), ['smile', 'blink']);
  assert.ok(Math.abs(skinned.morphTargetInfluences[1] - 0.25) < 1e-6);

  const faceMixer = new AnimationMixer(gltf.scene);
  const faceAction = faceMixer.clipAction(gltf.animations[1]);
  faceAction.setLoop(LoopOnce, 1);
  faceAction.clampWhenFinished = true;
  faceAction.play();
  faceMixer.update(2);
  assert.ok(Math.abs(skinned.morphTargetInfluences[0] - 1) < 1e-6);
  assert.ok(Math.abs(skinned.morphTargetInfluences[1] - 0.25) < 1e-6);

  const mixer = new AnimationMixer(gltf.scene);
  const action = mixer.clipAction(gltf.animations[0]);
  action.play();
  mixer.update(0.5);
  gltf.scene.updateMatrixWorld(true);
  skinned.skeleton.update();
  const localPose = sampleClip(clip, sk, 0.5, 'loop');
  const expected = evaluateTriangleMesh(sk, mesh, clip, 0.5, 'loop', computeWorldMatrices(sk, localPose));
  const morphed = [new Vector3(...positions[0]), new Vector3(...positions[1])];
  const influences = Array.from(skinned.morphTargetInfluences as number[]);
  skinned.geometry.morphAttributes.position.forEach((attribute: any, targetIndex: number) => {
    for (let i = 0; i < 2; i++) {
      morphed[i].addScaledVector(
        new Vector3(attribute.getX(i), attribute.getY(i), attribute.getZ(i)),
        influences[targetIndex],
      );
    }
  });
  for (let i = 0; i < 2; i++) {
    const loaded = new Vector3();
    const joint = skinned.geometry.attributes.skinIndex.array[i * 4] as number;
    const jointWeight = skinned.geometry.attributes.skinWeight.array[i * 4] as number;
    const matrix = new Matrix4().fromArray(
      Array.from(skinned.skeleton.boneMatrices.slice(joint * 16, joint * 16 + 16)),
    );
    loaded.addScaledVector(morphed[i].clone().applyMatrix4(matrix), jointWeight);
    assert.ok(Math.abs(loaded.x - expected[i][0]) < 1e-5);
    assert.ok(Math.abs(loaded.y - expected[i][1]) < 1e-5);
    assert.ok(Math.abs(loaded.z - expected[i][2]) < 1e-5);
  }
});
