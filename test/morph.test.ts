import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Skeleton,
  computeWorldMatrices,
  sampleClip,
  sampleMorphWeights,
  skinMorphedVertices,
  type AnimationClip,
  type SkinInfluence,
  type TriangleMesh,
  type Vec3,
} from '../src/index.js';
import { humanoidBones } from './helpers.js';

const skeleton = new Skeleton(humanoidBones());
const positions: Vec3[] = [
  [0, 1.5, 0],
  [0.1, 1.5, 0],
  [0.2, 1.45, 0],
];
const skinWeights: SkinInfluence[][] = [
  [{ boneId: 'head', weight: 1 }],
  [{ boneId: 'head', weight: 1 }],
  [{ boneId: 'spine', weight: 1 }],
];
const targets = [
  { name: 'smile', displacements: [[0, 0.1, 0], [0.1, 0, 0], [0, 0, 0]] as Vec3[] },
  { name: 'blink', defaultWeight: 0.25, displacements: [[0, 0, 0.05], [0, 0, -0.05], [0, 0, 0]] as Vec3[] },
  { name: 'mouth-a', displacements: [[0.02, 0, 0], [0, 0.03, 0], [0, 0, 0]] as Vec3[] },
];
const mesh: TriangleMesh = { name: 'face', positions, indices: [0, 1, 2], weights: skinWeights, targets };

test('形变目标校验名称、数量、位移和默认权重', () => {
  assert.throws(() => skinMorphedVertices(
    skeleton,
    { ...mesh, targets: [targets[0], { ...targets[0] }] },
    skinWeights,
    computeWorldMatrices(skeleton, sampleClip({ name: 'x', duration: 1, tracks: [] }, skeleton, 0, 'once')),
  ), /重复形变目标/);
  assert.throws(() => skinMorphedVertices(
    skeleton,
    { ...mesh, targets: [{ name: 'bad', displacements: [[0, 0, 0]] }] },
    skinWeights,
    new Map(),
  ), /顶点数量不符/);
  assert.throws(() => skinMorphedVertices(
    skeleton,
    { ...mesh, targets: [{ name: 'bad', displacements: [[0, Number.POSITIVE_INFINITY, 0], [0, 0, 0], [0, 0, 0]] }] },
    skinWeights,
    new Map(),
  ), /非有限位移/);
  assert.throws(() => skinMorphedVertices(
    skeleton,
    { ...mesh, targets: [{ name: 'bad', defaultWeight: 2, displacements: positions.map(() => [0, 0, 0] as Vec3) }] },
    skinWeights,
    new Map(),
  ), /默认权重/);
});

test('权重轨道线性插值、首尾延续、循环复用并取缺失目标默认值', () => {
  const clip: AnimationClip = {
    name: 'face-talk',
    duration: 1,
    tracks: [],
    morphTracks: [
      { targetName: 'smile', keys: [{ time: 0.25, value: 0 }, { time: 0.75, value: 1 }] },
      { targetName: 'mouth-a', keys: [{ time: 0, value: 0.2 }, { time: 0.5, value: 0.8 }, { time: 1, value: 0.4 }] },
    ],
  };
  assert.deepEqual(
    [...sampleMorphWeights(clip, targets, 0, 'once')],
    [['smile', 0], ['blink', 0.25], ['mouth-a', 0.2]],
  );
  const mid = sampleMorphWeights(clip, targets, 0.5, 'once');
  assert.equal(mid.get('smile'), 0.5);
  assert.equal(mid.get('mouth-a'), 0.8);
  const end = sampleMorphWeights(clip, targets, 2, 'once');
  assert.equal(end.get('smile'), 1);
  assert.equal(end.get('mouth-a'), 0.4);
  const wrapped = sampleMorphWeights(clip, targets, 1.25, 'loop');
  assert.equal(wrapped.get('smile'), 0);
  assert.equal(wrapped.get('mouth-a'), 0.5);
});

test('拒绝未知或重复表情轨道、非法时间和权重', () => {
  const base = { name: 'face', duration: 1, tracks: [] };
  assert.throws(() => sampleMorphWeights(
    { ...base, morphTracks: [{ targetName: 'ghost', keys: [{ time: 0, value: 0 }] }] },
    targets,
    0,
    'once',
  ), /未知形变目标/);
  assert.throws(() => sampleMorphWeights(
    { ...base, morphTracks: [
      { targetName: 'smile', keys: [{ time: 0, value: 0 }] },
      { targetName: 'smile', keys: [{ time: 1, value: 1 }] },
    ] },
    targets,
    0,
    'once',
  ), /重复表情轨道/);
  assert.throws(() => sampleMorphWeights(
    { ...base, morphTracks: [{ targetName: 'smile', keys: [{ time: 0.5, value: 0 }, { time: 0.5, value: 1 }] }] },
    targets,
    0,
    'once',
  ), /严格递增/);
  assert.throws(() => sampleMorphWeights(
    { ...base, morphTracks: [{ targetName: 'smile', keys: [{ time: 1.2, value: 0 }] }] },
    targets,
    0,
    'once',
  ), /非法时间/);
  assert.throws(() => sampleMorphWeights(
    { ...base, morphTracks: [{ targetName: 'smile', keys: [{ time: 0, value: -0.1 }] }] },
    targets,
    0,
    'once',
  ), /权重必须/);
});

test('先叠加独立形变再蒙皮，不归一化且不污染输入或结果', () => {
  const identity = computeWorldMatrices(
    skeleton,
    sampleClip({ name: 'bind', duration: 1, tracks: [] }, skeleton, 0, 'once'),
  );
  const first = skinMorphedVertices(skeleton, mesh, skinWeights, identity, new Map([
    ['smile', 1],
    ['blink', 1],
    ['mouth-a', 0.5],
  ]));
  assert.deepEqual(first[0], [0.01, 1.6, 0.05]);
  assert.deepEqual(first[1], [0.2, 1.515, -0.05]);
  const second = skinMorphedVertices(skeleton, mesh, skinWeights, identity, new Map());
  assert.deepEqual(second[0], [0, 1.5, 0.0125]);
  assert.deepEqual(positions[0], [0, 1.5, 0]);
  assert.deepEqual(targets[1].defaultWeight, 0.25);
});

test('只有表情轨道的片段也可在片段时钟播放，骨骼保持绑定姿态', () => {
  const clip: AnimationClip = {
    name: 'face-only',
    duration: 1,
    tracks: [],
    morphTracks: [{ targetName: 'smile', keys: [{ time: 0, value: 0 }, { time: 1, value: 1 }] }],
  };
  const pose = sampleClip(clip, skeleton, 0.5, 'once');
  const weights = sampleMorphWeights(clip, targets, 0.5, 'once');
  const out = skinMorphedVertices(skeleton, mesh, skinWeights, computeWorldMatrices(skeleton, pose), weights);
  assert.deepEqual(out[0], [0, 1.55, 0.0125]);
});
