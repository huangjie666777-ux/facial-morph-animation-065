import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnimationMixer, LoopOnce, Matrix4, Vector3 } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  Skeleton,
  RetargetPlan,
  bakeRetargetedClip,
  exportCharacterGlb,
  sampleClip,
  computeWorldMatrices,
  skinVertices,
  sampleMorphWeights,
  skinMorphedVertices,
  type AnimationClip,
  type MorphTarget,
  type BoneSpec,
  type SkinInfluence,
  type Vec3,
} from '../src/index.js';
import {
  humanoidBones,
  rootMotionWalkClip,
  IDENTITY_QUAT,
  UNIT_SCALE,
  quatZ,
} from './helpers.js';

const sk = new Skeleton(humanoidBones());
const positions: Vec3[] = [
  [0, 1.35, 0],
  [0.2, 1.25, 0],
  [-0.2, 1.25, 0],
  [0, 1.1, 0],
];
const weights: SkinInfluence[][] = [
  [{ boneId: 'spine', weight: 2 }, { boneId: 'hips', weight: 2 }],
  [{ boneId: 'arm.R', weight: 1 }],
  [{ boneId: 'arm.L', weight: 1 }],
  [{ boneId: 'hips', weight: 0.5 }, { boneId: 'leg.L', weight: 0.5 }],
];
const mesh = { name: 'test-mesh', positions, indices: [0, 1, 2, 0, 3, 1], weights };
const indices = mesh.indices;

function parseGlb(buffer: ArrayBuffer): Promise<any> {
  return new Promise((resolve, reject) => {
    new GLTFLoader().parse(buffer, '', resolve, reject);
  });
}

function parseJson(buffer: ArrayBuffer): any {
  const view = new DataView(buffer);
  assert.equal(view.getUint32(0, true), 0x46546c67);
  assert.equal(view.getUint32(4, true), 2);
  assert.equal(view.getUint32(8, true), buffer.byteLength);
  assert.equal(view.getUint32(12, true) % 4, 0);
  assert.equal(view.getUint32(16, true), 0x4e4f534a);
  const jsonLength = view.getUint32(12, true);
  return JSON.parse(Buffer.from(buffer, 20, jsonLength).toString('utf8'));
}

test('GLB 头、访问器、单缓冲与对齐符合 glTF 2.0', () => {
  const buffer = exportCharacterGlb({ skeleton: sk, mesh, clips: [rootMotionWalkClip()] });
  const gltf = parseJson(buffer);
  assert.equal(gltf.asset.version, '2.0');
  assert.equal(gltf.buffers.length, 1);
  assert.equal(gltf.buffers[0].uri, undefined);
  assert.equal(gltf.bufferViews.every((v: any) => v.byteOffset % 4 === 0 || v.byteOffset % 2 === 0), true);
  assert.equal(gltf.accessors.every((a: any) => a.bufferView !== undefined), true);
  assert.equal(gltf.skins[0].joints.length, sk.boneIds.length);
  assert.deepEqual(gltf.nodes[gltf.skins[0].skeleton].name, 'hips');
  assert.deepEqual(
    gltf.skins[0].joints.map((i: number) => gltf.nodes[i].name),
    [...sk.evalOrder],
  );
  assert.equal(gltf.animations[0].name, 'root-walk');
});

test('拒绝未知骨、负权重、零权重、非法值和越界索引且不修改输入', () => {
  const snapshot = JSON.parse(JSON.stringify({ positions, indices, weights }));
  assert.throws(
    () => exportCharacterGlb({
      skeleton: sk,
      mesh: { ...mesh, weights: [[{ boneId: 'ghost', weight: 1 }], ...weights.slice(1)] },
      clips: [],
    }),
    /未知骨骼/,
  );
  assert.throws(
    () => exportCharacterGlb({
      skeleton: sk,
      mesh: { ...mesh, weights: [[{ boneId: 'hips', weight: -1 }], ...weights.slice(1)] },
      clips: [],
    }),
    /非法权重/,
  );
  assert.throws(
    () => exportCharacterGlb({
      skeleton: sk,
      mesh: { ...mesh, weights: [[], ...weights.slice(1)] },
      clips: [],
    }),
    /缺少蒙皮权重|权重总和/,
  );
  assert.throws(
    () => exportCharacterGlb({
      skeleton: sk,
      mesh: { ...mesh, positions: [[Number.NaN, 0, 0], ...positions.slice(1)] },
      clips: [],
    }),
    /非法数值/,
  );
  assert.throws(
    () => exportCharacterGlb({
      skeleton: sk,
      mesh: { ...mesh, indices: [0, 1, 99] },
      clips: [],
    }),
    /越界/,
  );
  assert.deepEqual({ positions, indices, weights }, snapshot);
});

test('GLTFLoader 加载后的蒙皮结果与本库采样一致', async () => {
  const clip = rootMotionWalkClip();
  const buffer = exportCharacterGlb({ skeleton: sk, mesh, clips: [clip] });
  const gltf = await parseGlb(buffer.slice(0));
  const scene = gltf.scene;
  const skinned = scene.children.find((child: any) => child.isSkinnedMesh);
  assert.ok(skinned);

  for (const time of [0, 0.25, 0.75, 1]) {
    const mixer = new AnimationMixer(scene);
    const action = mixer.clipAction(gltf.animations[0]);
    action.setLoop(LoopOnce, 1);
    action.clampWhenFinished = true;
    action.play();
    mixer.update(time);
    scene.updateMatrixWorld(true);
    const localPose = sampleClip(clip, sk, time, 'once');
    const expected = skinVertices(sk, positions, weights, computeWorldMatrices(sk, localPose));
    const loaded: Vec3[] = [];
    skinned.skeleton.update();
    for (let i = 0; i < positions.length; i++) {
      const v = new Vector3(positions[i][0], positions[i][1], positions[i][2]);
      const out = new Vector3();
      for (let slot = 0; slot < 4; slot++) {
        const componentIndex = i * 4 + slot;
        const joint = skinned.geometry.attributes.skinIndex.array[componentIndex] as number;
        const weight = skinned.geometry.attributes.skinWeight.array[componentIndex] as number;
        if (weight === 0) continue;
        const m = new Matrix4().fromArray(
          Array.from(skinned.skeleton.boneMatrices.slice(joint * 16, joint * 16 + 16)),
        );
        out.addScaledVector(v.clone().applyMatrix4(m), weight);
      }
      loaded.push([out.x, out.y, out.z]);
      assert.ok(Math.abs(out.x - expected[i][0]) < 1e-5);
      assert.ok(Math.abs(out.y - expected[i][1]) < 1e-5);
      assert.ok(Math.abs(out.z - expected[i][2]) < 1e-5);
    }
    assert.equal(loaded.length, positions.length);
  }
});

test('缺失首尾通道自动延续端值，缺失 TRS 通道保留绑定值', async () => {
  const partialClip = {
    name: 'partial',
    duration: 1,
    tracks: [{
      boneId: 'leg.L',
      rotations: [
        { time: 0.25, value: quatZ(0.2) },
        { time: 0.75, value: quatZ(0.8) },
      ],
    }],
  };
  const buffer = exportCharacterGlb({ skeleton: sk, mesh, clips: [partialClip] });
  const gltf = parseJson(buffer);
  const loaded = await parseGlb(buffer.slice(0));
  const mixer = new AnimationMixer(loaded.scene);
  const action = mixer.clipAction(loaded.animations[0]);
  action.setLoop(LoopOnce, 1);
  action.clampWhenFinished = true;
  const leg = loaded.scene.children[0].children.find((child: any) => child.children.length === 0 && child.name === 'legL');
  for (const [time, angle] of [[0, 0.2], [1, 0.8]] as const) {
    action.reset().play();
    mixer.update(time);
    assert.ok(Math.abs(leg.quaternion.z - Math.sin(angle / 2)) < 1e-6);
    assert.deepEqual(leg.position.toArray().map((n: number) => Number(n.toFixed(6))), [0.1, 0, 0]);
    assert.deepEqual(leg.scale.toArray(), [1, 1, 1]);
  }
});

test('没有有效通道的静态片段也保留名称和完整时长', () => {
  const gltf = parseJson(exportCharacterGlb(sk, mesh, [
    { name: 'static-pose', duration: 2.5, tracks: [] },
  ]));
  assert.equal(gltf.animations[0].name, 'static-pose');
  const sampler = gltf.animations[0].samplers[0];
  const timeView = gltf.accessors[sampler.input];
  assert.equal(timeView.count, 2);
  assert.deepEqual(timeView.min, [0]);
  assert.deepEqual(timeView.max, [2.5]);
});

test('可导出重定向烘焙片段并保留完整层级、片段名和根位移终点', async () => {
  const targetBones: BoneSpec[] = [
    { id: 'j_hips', parentId: null, translation: [0, 0.8, 0], rotation: IDENTITY_QUAT, scale: UNIT_SCALE },
    { id: 'j_mid', parentId: 'j_hips', translation: [0, 0.12, 0], rotation: IDENTITY_QUAT, scale: UNIT_SCALE },
    { id: 'j_spine', parentId: 'j_mid', translation: [0, 0.2, 0], rotation: IDENTITY_QUAT, scale: UNIT_SCALE },
  ];
  const target = new Skeleton(targetBones);
  const plan = new RetargetPlan({
    source: sk,
    target,
    mapping: [
      { sourceBoneId: 'hips', targetBoneId: 'j_hips' },
      { sourceBoneId: 'spine', targetBoneId: 'j_spine' },
    ],
  });
  const baked = bakeRetargetedClip(plan, rootMotionWalkClip(), {
    sampleTimes: [0, 0.5, 1],
    rootTranslationScale: 0.5,
    name: 'baked-export',
  });
  const targetMesh = {
    name: 'target-mesh',
    positions: [[0, 1.12, 0]] as Vec3[],
    indices: [0, 0, 0, 0, 0, 0] as number[],
    weights: [[{ boneId: 'j_mid', weight: 1 }]] as SkinInfluence[][],
  };
  const gltf = await parseGlb(exportCharacterGlb({ skeleton: target, mesh: targetMesh, clips: [baked] }).slice(0));
  assert.equal(gltf.animations[0].name, 'baked-export');
  const mixer = new AnimationMixer(gltf.scene);
  const action = mixer.clipAction(gltf.animations[0]);
  action.setLoop(LoopOnce, 1);
  action.clampWhenFinished = true;
  action.play();
  mixer.update(1);
  gltf.scene.updateMatrixWorld(true);
  const hips = gltf.scene.getObjectByName('j_hips');
  assert.ok(Math.abs(hips.position.x - 0.2) < 1e-6);
  assert.ok(Math.abs(hips.position.y - 0.8) < 1e-6);
  assert.ok(gltf.scene.getObjectByName('j_mid'));
});

test('GLB 保留形变目标顺序名称默认值，并与骨骼动画同时播放', async () => {
  const targets: MorphTarget[] = [
    { name: 'smile', displacements: [[0, 0.08, 0], [0, 0, 0.04], [0, 0, -0.04], [0, 0.06, 0]] },
    { name: 'blink', defaultWeight: 0.15, displacements: [[0, 0, 0.03], [0, 0, 0.02], [0, 0, 0.02], [0, 0, 0.01]] },
    { name: 'mouth-a', defaultWeight: 0.25, displacements: [[0.01, 0, 0], [0.02, 0, 0], [0.02, 0, 0], [0, 0, 0]] },
  ];
  const morphMesh = { ...mesh, targets };
  const clip: AnimationClip = {
    name: 'walk-face',
    duration: 1,
    tracks: rootMotionWalkClip().tracks,
    morphTracks: [
      { targetName: 'smile', keys: [{ time: 0.3, value: 0.2 }, { time: 0.8, value: 1 }] },
      { targetName: 'blink', keys: [{ time: 0.2, value: 0 }, { time: 1, value: 1 }] },
      { targetName: 'mouth-a', keys: [{ time: 0.1, value: 0 }, { time: 0.9, value: 1 }] },
    ],
  };
  const buffer = exportCharacterGlb({ skeleton: sk, mesh: morphMesh, clips: [clip] });
  const gltfJson = parseJson(buffer);
  const primitive = gltfJson.meshes[0].primitives[0];
  assert.deepEqual(gltfJson.meshes[0].extras.targetNames, ['smile', 'blink', 'mouth-a']);
  assert.deepEqual(gltfJson.meshes[0].weights, [0, 0.15, 0.25]);
  assert.equal(primitive.targets.length, 3);

  const animation = gltfJson.animations[0];
  const weightsChannel = animation.channels.find((c: any) => c.target.path === 'weights');
  assert.equal(weightsChannel.target.node, sk.boneIds.length);
  const sampler = animation.samplers[weightsChannel.sampler];
  assert.equal(gltfJson.accessors[sampler.output].type, 'SCALAR');
  assert.equal(gltfJson.accessors[sampler.output].count, 7 * 3);

  const loaded = await parseGlb(buffer.slice(0));
  const skinned = loaded.scene.children.find((child: any) => child.isSkinnedMesh);
  const mixer = new AnimationMixer(loaded.scene);
  const action = mixer.clipAction(loaded.animations[0]);
  action.setLoop(LoopOnce, 1);
  action.clampWhenFinished = true;
  action.play();
  const time = 0.55;
  mixer.update(time);
  loaded.scene.updateMatrixWorld(true);
  skinned.skeleton.update();

  const localPose = sampleClip(clip, sk, time, 'once');
  const morphWeights = sampleMorphWeights(clip, targets, time, 'once');
  const expected = skinMorphedVertices(
    sk,
    morphMesh,
    weights,
    computeWorldMatrices(sk, localPose),
    morphWeights,
  );
  const influences = skinned.morphTargetInfluences as number[];
  for (let i = 0; i < positions.length; i++) {
    const v = new Vector3(positions[i][0], positions[i][1], positions[i][2]);
    targets.forEach((target, targetIndex) => {
      const d = target.displacements[i];
      v.addScaledVector(new Vector3(d[0], d[1], d[2]), influences[targetIndex]);
    });
    const out = new Vector3();
    for (let slot = 0; slot < 4; slot++) {
      const componentIndex = i * 4 + slot;
      const joint = skinned.geometry.attributes.skinIndex.array[componentIndex] as number;
      const weight = skinned.geometry.attributes.skinWeight.array[componentIndex] as number;
      if (weight === 0) continue;
      const m = new Matrix4().fromArray(
        Array.from(skinned.skeleton.boneMatrices.slice(joint * 16, joint * 16 + 16)),
      );
      out.addScaledVector(v.clone().applyMatrix4(m), weight);
    }
    assert.ok(Math.abs(out.x - expected[i][0]) < 1e-5);
    assert.ok(Math.abs(out.y - expected[i][1]) < 1e-5);
    assert.ok(Math.abs(out.z - expected[i][2]) < 1e-5);
  }
});

test('拒绝转 Float32 后溢出的有限坐标', () => {
  assert.throws(
    () => exportCharacterGlb({
      skeleton: sk,
      mesh: { ...mesh, positions: [[1e40, 0, 0], ...positions.slice(1)] },
      clips: [],
    }),
    /Float32/,
  );
});
