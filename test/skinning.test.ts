import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Matrix4 } from 'three';
import {
  Skeleton,
  evaluatePose,
  skinMorphedVerticesToWorld,
  skinVertices,
} from '../src/index.js';
import { humanoidBones, walkClip, waveClip } from './helpers.js';

const sk = new Skeleton(humanoidBones());

test('权重归一化：非归一输入与归一输入结果一致', () => {
  const pose = evaluatePose(sk, { clip: walkClip(), time: 0.25, loop: 'loop' });
  const verts: [number, number, number][] = [[0, 1.2, 0]];
  const a = skinVertices(sk, verts, [[{ boneId: 'hips', weight: 1 }, { boneId: 'spine', weight: 1 }]], pose.worldMatrices);
  const b = skinVertices(sk, verts, [[{ boneId: 'hips', weight: 0.5 }, { boneId: 'spine', weight: 0.5 }]], pose.worldMatrices);
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(a[0][i] - b[0][i]) < 1e-12);
});

test('绑定姿态下蒙皮输出等于输入顶点', () => {
  const pose = evaluatePose(sk, { clip: walkClip(), time: 0, loop: 'once' });
  // 用绑定姿态世界矩阵：time=0 时 walk 的 hips 平移恰为绑定值，但腿有旋转，
  // 因此直接用骨架绑定世界矩阵构造恒等蒙皮。
  const bindWorld = new Map(sk.boneIds.map((id) => [id, sk.bindWorldMatrix(id)]));
  const verts: [number, number, number][] = [[0.05, 1.35, 0], [-0.25, 1.35, 0]];
  const out = skinVertices(sk, verts, [
    [{ boneId: 'hand.L', weight: 1 }],
    [{ boneId: 'arm.L', weight: 0.3 }, { boneId: 'spine', weight: 0.7 }],
  ], bindWorld);
  for (let v = 0; v < verts.length; v++) {
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(out[v][i] - verts[v][i]) < 1e-9);
  }
  void pose;
});

test('零总权重保持原位置', () => {
  const pose = evaluatePose(sk, { clip: walkClip(), time: 0.4, loop: 'loop' });
  const out = skinVertices(sk, [[1, 2, 3]], [[]], pose.worldMatrices);
  assert.deepEqual(out[0], [1, 2, 3]);
  const out2 = skinVertices(sk, [[1, 2, 3]], [[{ boneId: 'hips', weight: 0 }]], pose.worldMatrices);
  assert.deepEqual(out2[0], [1, 2, 3]);
});

test('拒绝未知骨骼、负权重、超过 4 个影响', () => {
  const pose = evaluatePose(sk, { clip: walkClip(), time: 0, loop: 'once' });
  assert.throws(
    () => skinVertices(sk, [[0, 0, 0]], [[{ boneId: 'ghost', weight: 1 }]], pose.worldMatrices),
    /未知骨骼/,
  );
  assert.throws(
    () => skinVertices(sk, [[0, 0, 0]], [[{ boneId: 'hips', weight: -0.1 }]], pose.worldMatrices),
    /非法权重/,
  );
  assert.throws(
    () => skinVertices(sk, [[0, 0, 0]], [[
      { boneId: 'hips', weight: 0.2 }, { boneId: 'spine', weight: 0.2 },
      { boneId: 'head', weight: 0.2 }, { boneId: 'arm.L', weight: 0.2 },
      { boneId: 'arm.R', weight: 0.2 },
    ]], pose.worldMatrices),
    /超过 4/,
  );
});

test('不修改输入，多实例互不串状态', () => {
  const poseA = evaluatePose(sk, { clip: walkClip(), time: 0.25, loop: 'loop' }, {
    clip: waveClip(), time: 0.4, loop: 'loop', strength: 1, mask: { 'arm.R': 1 },
  });
  const poseB = evaluatePose(sk, { clip: walkClip(), time: 0.25, loop: 'loop' });
  const verts: [number, number, number][] = [[0.55, 1.35, 0]];
  const weights = [[{ boneId: 'hand.R', weight: 1 }]] as const;
  const vertsSnapshot = JSON.parse(JSON.stringify(verts));
  const weightsSnapshot = JSON.parse(JSON.stringify(weights));
  const outA = skinVertices(sk, verts, weights, poseA.worldMatrices);
  const outB = skinVertices(sk, verts, weights, poseB.worldMatrices);
  // 输入未被修改
  assert.deepEqual(verts, vertsSnapshot);
  assert.deepEqual(weights, weightsSnapshot);
  // 挥手实例与纯行走实例结果不同，且再次计算互不影响
  assert.ok(Math.abs(outA[0][0] - outB[0][0]) + Math.abs(outA[0][1] - outB[0][1]) > 0.05);
  const outA2 = skinVertices(sk, verts, weights, poseA.worldMatrices);
  assert.deepEqual(outA2, outA);
  // 返回的是新数组
  assert.notEqual(outA[0] as unknown, verts[0] as unknown);
});

test('世界空间表情形变蒙皮只应用一次角色矩阵', () => {
  const bindWorld = new Map(sk.boneIds.map((id) => [id, sk.bindWorldMatrix(id)]));
  const positions = [[0, 1.5, 0]] as [number, number, number][];
  const mesh = {
    name: 'face-world',
    positions,
    indices: [0, 0, 0] as number[],
    weights: [[{ boneId: 'head', weight: 1 }]],
    targets: [{ name: 'blink', displacements: [[0, -0.02, 0.04]] as [number, number, number][] }],
  };
  const character = new Matrix4().makeTranslation(2, 3, 4);
  const out = skinMorphedVerticesToWorld(
    sk,
    mesh,
    mesh.weights,
    bindWorld,
    character,
    new Map([['blink', 0.5]]),
  );
  assert.deepEqual(out[0], [2, 4.49, 4.02]);
});
