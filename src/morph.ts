import type { Matrix4 } from 'three';
import { sampleKeys, validateClip } from './clip.js';
import { resolveClipTime } from './pose.js';
import type { Skeleton } from './skeleton.js';
import { skinVertices } from './skinning.js';
import type {
  AnimationClip,
  LoopMode,
  MorphTarget,
  TriangleMesh,
  Vec3,
} from './types.js';

const FLOAT32_MAX = 3.4028234663852886e38;

function isFloat32Finite(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value) <= FLOAT32_MAX;
}

/** 校验有限数可安全写入 glTF FLOAT 而不变成 Infinity。 */
export function assertFloat32Finite(value: number, what: string): void {
  if (!isFloat32Finite(value)) throw new Error(what + ' 不是可导出的有限 FLOAT32 值: ' + String(value));
}

/** 校验三角网格的形变目标；通过后返回按输入顺序排列的有效目标副本。 */
export function validateMorphTargets(mesh: TriangleMesh): MorphTarget[] {
  if (!mesh || !Array.isArray(mesh.positions)) throw new Error('形变网格缺少 positions');
  const targets = mesh.morphTargets ?? [];
  if (!Array.isArray(targets)) throw new Error('morphTargets 必须是数组');
  const names = new Set<string>();
  return targets.map((target, targetIndex) => {
    if (!target || typeof target.name !== 'string' || target.name.length === 0) {
      throw new Error('形变目标 ' + targetIndex + ' 缺少名称');
    }
    if (names.has(target.name)) throw new Error('形变目标名称重复: ' + target.name);
    names.add(target.name);
    if (!Array.isArray(target.displacements)) {
      throw new Error('形变目标 ' + target.name + ' 缺少 displacements');
    }
    if (target.displacements.length !== mesh.positions.length) {
      throw new Error(
        '形变目标 ' + target.name + ' 的位移数与顶点数不一致: '
          + target.displacements.length + ' vs ' + mesh.positions.length,
      );
    }
    const defaultWeight = target.defaultWeight ?? 0;
    if (!Number.isFinite(defaultWeight) || defaultWeight < 0 || defaultWeight > 1) {
      throw new Error('形变目标 ' + target.name + ' 默认权重必须在 [0, 1]: ' + String(defaultWeight));
    }
    const displacements = target.displacements.map((d: Vec3, vertexIndex: number) => {
      if (!d || !d.every(Number.isFinite)) {
        throw new Error('形变目标 ' + target.name + ' 顶点 ' + vertexIndex + ' 位移含非法数值');
      }
      return [d[0], d[1], d[2]] as Vec3;
    });
    return { name: target.name, displacements, defaultWeight };
  });
}

export interface PreparedMorphTargets {
  readonly targets: MorphTarget[];
  readonly byName: ReadonlyMap<string, number>;
  readonly defaultWeights: Float32Array;
  /** 每个目标一组 VEC3 位移，顺序与 targets 相同。 */
  readonly displacements: Float32Array[];
}

/** 校验并复制形变目标数据为 glTF/CPU 共用的紧凑布局。 */
export function prepareMorphTargets(mesh: TriangleMesh): PreparedMorphTargets {
  const targets = validateMorphTargets(mesh);
  const byName = new Map<string, number>();
  const defaultWeights = new Float32Array(targets.length);
  const displacements = targets.map((target, index) => {
    byName.set(target.name, index);
    defaultWeights[index] = target.defaultWeight ?? 0;
    const array = new Float32Array(mesh.positions.length * 3);
    target.displacements.forEach((d, vertexIndex) => {
      for (let component = 0; component < 3; component++) {
        const value = d[component];
        assertFloat32Finite(value, '形变目标 ' + target.name + ' 顶点 ' + vertexIndex);
        array[vertexIndex * 3 + component] = value;
      }
    });
    return array;
  });
  return { targets, byName, defaultWeights, displacements };
}

/** 采样片段中的形变权重；缺失目标轨道时取该目标默认权重。 */
export function sampleMorphWeights(
  clip: AnimationClip,
  targets: readonly MorphTarget[] | PreparedMorphTargets,
  time: number,
  loop: LoopMode,
): number[] {
  const validTargets = 'byName' in targets ? targets.targets : targets;
  validateClip(clip, undefined, validTargets);
  const clipTime = resolveClipTime(time, clip.duration, loop);
  const tracks = new Map((clip.morphTracks ?? []).map((track) => [track.targetName, track]));
  return validTargets.map((target, index) => {
    const track = tracks.get(target.name);
    const value = track && sampleKeys(track.keys, clipTime, (a, b, t) => a + (b - a) * t);
    return value ?? validTargets[index].defaultWeight ?? 0;
  });
}

/** 将独立形变权重线性叠加到绑定顶点；权重不归一化，输入不被修改。 */
export function applyMorphTargets(
  mesh: TriangleMesh,
  weights: readonly number[],
): Vec3[] {
  const targets = validateMorphTargets(mesh);
  if (!Array.isArray(weights) || weights.length !== targets.length) {
    throw new Error('形变权重数与目标数不一致: ' + weights.length + ' vs ' + targets.length);
  }
  weights.forEach((weight, index) => {
    if (!Number.isFinite(weight) || weight < 0 || weight > 1) {
      throw new Error('形变目标 ' + targets[index].name + ' 权重必须在 [0, 1]: ' + String(weight));
    }
  });
  return mesh.positions.map((p, vertexIndex) => {
    if (!p || !p.every(Number.isFinite)) throw new Error('顶点 ' + vertexIndex + ' 含非法数值');
    let x = p[0];
    let y = p[1];
    let z = p[2];
    targets.forEach((target, targetIndex) => {
      const weight = weights[targetIndex];
      if (weight === 0) return;
      const displacement = target.displacements[vertexIndex];
      x += displacement[0] * weight;
      y += displacement[1] * weight;
      z += displacement[2] * weight;
    });
    return [x, y, z] as Vec3;
  });
}

/** CPU 表情求值：先叠加形变位移，再按当前骨骼姿态蒙皮。 */
export function skinTriangleMesh(
  skeleton: Skeleton,
  mesh: TriangleMesh,
  worldMatrices: ReadonlyMap<string, Matrix4>,
  morphWeights?: readonly number[],
): Vec3[] {
  const targets = validateMorphTargets(mesh);
  const weights = morphWeights ?? targets.map((target) => target.defaultWeight ?? 0);
  const morphedBindPositions = applyMorphTargets(mesh, weights);
  return skinVertices(skeleton, morphedBindPositions, mesh.weights, worldMatrices);
}

/** 采样片段并执行“先形变后蒙皮”，可直接接混合或 IK 后的骨骼矩阵。 */
export function evaluateTriangleMesh(
  skeleton: Skeleton,
  mesh: TriangleMesh,
  clip: AnimationClip,
  time: number,
  loop: LoopMode,
  worldMatrices: ReadonlyMap<string, Matrix4>,
): Vec3[] {
  return skinTriangleMesh(skeleton, mesh, worldMatrices, sampleMorphWeights(clip, validateMorphTargets(mesh), time, loop));
}
