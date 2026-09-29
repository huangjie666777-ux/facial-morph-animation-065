import { Matrix4, Vector3 } from 'three';
import type { SkinInfluence, TriangleMesh, Vec3 } from './types.js';
import type { Skeleton } from './skeleton.js';
import { skinMorphedVertices } from './morph.js';
import { rigidCharacterInverse } from './world-ik.js';

/** 角色空间先形变后蒙皮，再对结果只施加一次角色世界矩阵。 */
export function skinMorphedVerticesToWorld(
  skeleton: Skeleton,
  mesh: TriangleMesh,
  skinWeights: readonly (readonly SkinInfluence[])[],
  boneMatrices: ReadonlyMap<string, Matrix4>,
  characterMatrix: Matrix4,
  morphWeights: ReadonlyMap<string, number>,
): Vec3[] {
  rigidCharacterInverse(characterMatrix);
  const vertices = skinMorphedVertices(skeleton, mesh, skinWeights, boneMatrices, morphWeights);
  return vertices.map((vertex) => {
    const p = new Vector3(vertex[0], vertex[1], vertex[2]).applyMatrix4(characterMatrix);
    return [p.x, p.y, p.z] as Vec3;
  });
}
