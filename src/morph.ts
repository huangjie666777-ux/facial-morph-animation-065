import type { Matrix4 } from 'three';
import type { AnimationClip, LoopMode, MorphTarget, SkinInfluence, TriangleMesh, Vec3 } from './types.js';
import { resolveClipTime } from './pose.js';
import { sampleKeys } from './clip.js';
import { skinVertices } from './skinning.js';
import type { Skeleton } from './skeleton.js';

const lerpNumber = (a: number, b: number, t: number): number => a + (b - a) * t;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isWeightMap(
  value: ReadonlyMap<string, number> | AnimationClip | undefined,
): value is ReadonlyMap<string, number> {
  return value instanceof Map;
}

/** 校验命名形变目标：名称唯一、位移数量与绑定顶点一致、默认权重合法。 */
export function validateMorphTargets(mesh: Pick<TriangleMesh, 'positions' | 'targets'>): readonly MorphTarget[] {
  mesh.positions.forEach((position, index) => {
    if (!position || !position.every(Number.isFinite)) {
      throw new Error('绑定顶点 ' + index + ' 含非法数值');
    }
  });
  const targets = mesh.targets ?? [];
  if (!Array.isArray(targets)) throw new Error('形变目标必须是数组');
  const names = new Set<string>();
  for (const target of targets) {
    if (!target || typeof target.name !== 'string' || target.name.length === 0) {
      throw new Error('形变目标名称不能为空');
    }
    if (names.has(target.name)) throw new Error('重复形变目标: ' + target.name);
    names.add(target.name);
    if (!Array.isArray(target.displacements)) {
      throw new Error('形变目标 ' + target.name + ' 的位移必须是数组');
    }
    if (target.displacements.length !== mesh.positions.length) {
      throw new Error(
        '形变目标 ' + target.name + ' 顶点数量不符: '
        + target.displacements.length + ' vs ' + mesh.positions.length,
      );
    }
    target.displacements.forEach((d: Vec3, index: number) => {
      if (!d || !d.every(Number.isFinite)) {
        throw new Error('形变目标 ' + target.name + ' 顶点 ' + index + ' 含非有限位移');
      }
    });
    const defaultWeight = target.defaultWeight ?? 0;
    if (!isFiniteNumber(defaultWeight) || defaultWeight < 0 || defaultWeight > 1) {
      throw new Error('形变目标 ' + target.name + ' 默认权重必须在 [0, 1]: ' + String(defaultWeight));
    }
  }
  return targets;
}

/** 校验片段中的表情权重轨道：目标必须存在、轨道不重复，时间和权重均合法。 */
export function validateMorphTracks(
  clip: Pick<AnimationClip, 'name' | 'duration' | 'morphTracks'>,
  targets: readonly MorphTarget[],
): void {
  const tracks = clip.morphTracks ?? [];
  if (!Array.isArray(tracks)) throw new Error('片段 ' + clip.name + ' 的表情轨道必须是数组');
  const byName = new Map(targets.map((target) => [target.name, target]));
  const seen = new Set<string>();
  let previousTime = -Infinity;
  for (const track of tracks) {
    if (!track || typeof track.targetName !== 'string' || !byName.has(track.targetName)) {
      throw new Error('片段 ' + clip.name + ' 引用了未知形变目标: ' + String(track?.targetName));
    }
    if (seen.has(track.targetName)) {
      throw new Error('片段 ' + clip.name + ' 存在重复表情轨道: ' + track.targetName);
    }
    seen.add(track.targetName);
    if (!Array.isArray(track.keys) || track.keys.length === 0) {
      throw new Error('片段 ' + clip.name + ' 表情轨道 ' + track.targetName + ' 至少需要一个关键帧');
    }
    previousTime = -Infinity;
    for (const key of track.keys) {
      if (!key || !Number.isFinite(key.time) || key.time < 0 || key.time > clip.duration) {
        throw new Error('片段 ' + clip.name + ' 表情轨道 ' + track.targetName + ' 存在非法时间');
      }
      if (key.time <= previousTime) {
        throw new Error('片段 ' + clip.name + ' 表情轨道 ' + track.targetName + ' 时间必须严格递增');
      }
      previousTime = key.time;
      if (!isFiniteNumber(key.value) || key.value < 0 || key.value > 1) {
        throw new Error(
          '片段 ' + clip.name + ' 表情轨道 ' + track.targetName + ' 权重必须在 [0, 1]: '
          + String(key.value),
        );
      }
    }
  }
}

/** 返回按目标名称索引的权重；缺失轨道取目标默认权重。 */
export function sampleMorphWeights(
  clip: AnimationClip,
  targets: readonly MorphTarget[],
  time: number,
  loop: LoopMode,
): Map<string, number> {
  if (!Number.isFinite(clip.duration) || clip.duration <= 0) {
    throw new Error('片段 ' + clip.name + ' 时长必须为正数');
  }
  validateMorphTracks(clip, targets);
  const clipTime = resolveClipTime(time, clip.duration, loop);
  const tracks = new Map((clip.morphTracks ?? []).map((track) => [track.targetName, track]));
  const weights = new Map<string, number>();
  for (const target of targets) {
    const track = tracks.get(target.name);
    weights.set(
      target.name,
      track
        ? sampleKeys(track.keys, clipTime, lerpNumber)!
        : (target.defaultWeight ?? 0),
    );
  }
  return weights;
}

/**
 * 先把各目标的加权位移叠加到绑定顶点，再交给当前骨骼姿态蒙皮。
 * 不修改输入或之前返回的数组；不同角色传入不同网格不会共享状态。
 */
export function skinMorphedVertices(
  skeleton: Skeleton,
  mesh: TriangleMesh,
  skinWeights: readonly (readonly SkinInfluence[])[],
  worldMatrices: ReadonlyMap<string, Matrix4>,
  weightsOrClip?: ReadonlyMap<string, number> | AnimationClip,
  time = 0,
  loop: LoopMode = 'once',
): Vec3[] {
  const targets = validateMorphTargets(mesh);
  let weightMap: ReadonlyMap<string, number>;
  if (isWeightMap(weightsOrClip)) {
    weightMap = weightsOrClip;
  } else {
    const clip = weightsOrClip ?? { name: 'default', duration: 1, tracks: [] };
    weightMap = sampleMorphWeights(clip, targets, time, loop);
  }
  for (const name of weightMap.keys()) {
    if (!targets.some((target) => target.name === name)) {
      throw new Error('未知形变目标权重: ' + name);
    }
  }
  const morphedBindPositions = mesh.positions.map((position, vertexIndex): Vec3 => {
    let x = position[0];
    let y = position[1];
    let z = position[2];
    for (const target of targets) {
      const weight = weightMap.get(target.name) ?? target.defaultWeight ?? 0;
      if (!isFiniteNumber(weight) || weight < 0 || weight > 1) {
        throw new Error('形变目标 ' + target.name + ' 权重必须在 [0, 1]: ' + String(weight));
      }
      if (weight === 0) continue;
      const displacement = target.displacements[vertexIndex];
      x += displacement[0] * weight;
      y += displacement[1] * weight;
      z += displacement[2] * weight;
    }
    return [x, y, z];
  });

  return skinVertices(skeleton, morphedBindPositions, skinWeights, worldMatrices);
}
