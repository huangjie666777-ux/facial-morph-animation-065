import type { TriangleMesh } from './types.js';
import type { Skeleton } from './skeleton.js';
import { assertFloat32Finite, prepareMorphTargets, type PreparedMorphTargets } from './morph.js';

export interface PreparedTriangleMesh {
  readonly name: string;
  readonly vertexCount: number;
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
  readonly joints: Uint16Array | Uint32Array;
  readonly weights: Float32Array;
  readonly morphTargets: PreparedMorphTargets;
}

/** 校验并适配三角网格；权重复制到固定四影响布局，不修改输入。 */
export function prepareTriangleMesh(
  skeleton: Skeleton,
  mesh: TriangleMesh,
): PreparedTriangleMesh {
  if (!mesh || !Array.isArray(mesh.positions) || !Array.isArray(mesh.indices) || !Array.isArray(mesh.weights)) {
    throw new Error('GLB 网格缺少 positions、indices 或 weights');
  }
  const vertexCount = mesh.positions.length;
  if (vertexCount === 0) throw new Error('GLB 网格至少需要一个顶点');
  if (mesh.weights.length !== vertexCount) {
    throw new Error('顶点数与权重数不一致: ' + vertexCount + ' vs ' + mesh.weights.length);
  }
  if (mesh.indices.length === 0 || mesh.indices.length % 3 !== 0) {
    throw new Error('GLB 网格三角索引必须是非空且长度为 3 的倍数');
  }

  const positions = new Float32Array(vertexCount * 3);
  for (let v = 0; v < vertexCount; v++) {
    const p = mesh.positions[v];
    if (!p || !p.every(Number.isFinite)) {
      throw new Error('顶点 ' + v + ' 含非法数值');
    }
    for (let component = 0; component < 3; component++) {
      assertFloat32Finite(p[component], '顶点 ' + v);
      positions[v * 3 + component] = p[component];
    }
  }

  const indices = new Uint32Array(mesh.indices.length);
  for (let i = 0; i < mesh.indices.length; i++) {
    const index = mesh.indices[i];
    if (!Number.isInteger(index) || index < 0 || index >= vertexCount) {
      throw new Error('三角索引 ' + i + ' 越界或非法: ' + String(index));
    }
    indices[i] = index;
  }

  const jointIndexOf = new Map(skeleton.evalOrder.map((id, index) => [id, index]));
  const useUint32Joints = skeleton.boneIds.length > 65535;
  const joints = useUint32Joints
    ? new Uint32Array(vertexCount * 4)
    : new Uint16Array(vertexCount * 4);
  const weights = new Float32Array(vertexCount * 4);

  for (let v = 0; v < vertexCount; v++) {
    const influences = mesh.weights[v];
    if (!Array.isArray(influences) || influences.length === 0) {
      throw new Error('顶点 ' + v + ' 缺少蒙皮权重');
    }
    if (influences.length > 4) {
      throw new Error('顶点 ' + v + ' 的骨骼影响数超过 4');
    }
    const slots = new Map<number, number>();
    let total = 0;
    for (const inf of influences) {
      if (!inf || typeof inf.boneId !== 'string') {
        throw new Error('顶点 ' + v + ' 的蒙皮影响非法');
      }
      if (!Number.isFinite(inf.weight) || inf.weight < 0) {
        throw new Error('顶点 ' + v + ' 存在非法权重: ' + String(inf.weight));
      }
      const jointIndex = jointIndexOf.get(inf.boneId);
      if (jointIndex === undefined) {
        throw new Error('蒙皮权重引用了未知骨骼: ' + inf.boneId);
      }
      slots.set(jointIndex, (slots.get(jointIndex) ?? 0) + inf.weight);
      total += inf.weight;
    }
    if (!Number.isFinite(total) || total <= 0) {
      throw new Error('顶点 ' + v + ' 权重总和必须为正数');
    }
    let slot = 0;
    for (const [jointIndex, weight] of slots) {
      if (weight === 0) continue;
      joints[v * 4 + slot] = jointIndex;
      weights[v * 4 + slot] = weight / total;
      slot++;
    }
  }

  const morphTargets = prepareMorphTargets(mesh);

  return {
    name: mesh.name ?? 'character-mesh',
    vertexCount,
    positions,
    indices,
    joints,
    weights,
    morphTargets,
  };
}
