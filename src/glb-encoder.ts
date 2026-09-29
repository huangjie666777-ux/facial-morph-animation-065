import type { Skeleton } from './skeleton.js';
import type { AnimationClip, GlbCharacterAsset, TriangleMesh } from './types.js';
import { prepareTriangleMesh, type PreparedTriangleMesh } from './gltf-mesh.js';
import { prepareGlbAnimations, type GltfAnimation } from './gltf-animation.js';

function isSkeletonLike(value: unknown): value is Skeleton {
  return typeof value === 'object'
    && value !== null
    && 'evalOrder' in value
    && 'bindLocalTransform' in value
    && 'inverseBindMatrix' in value;
}

type AccessorType = 'SCALAR' | 'VEC3' | 'VEC4' | 'MAT4';

interface GltfBufferView {
  buffer: 0;
  byteOffset: number;
  byteLength: number;
  byteStride?: undefined;
  target?: number;
}

interface GltfAccessor {
  bufferView: number;
  componentType: number;
  count: number;
  type: AccessorType;
  min?: number[];
  max?: number[];
  normalized?: false;
}

interface GltfNode {
  name: string;
  children?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
  mesh?: number;
  skin?: number;
}

class BinaryWriter {
  private parts: Uint8Array[] = [];
  private lengthValue = 0;

  get length(): number {
    return this.lengthValue;
  }

  addArray(array: ArrayBufferView, alignment: number): { byteOffset: number; byteLength: number } {
    const byteLength = array.byteLength;
    this.align(alignment);
    const byteOffset = this.lengthValue;
    this.parts.push(new Uint8Array(array.buffer, array.byteOffset, byteLength));
    this.lengthValue += byteLength;
    return { byteOffset, byteLength };
  }

  align(alignment: number): void {
    const padding = (alignment - (this.lengthValue % alignment)) % alignment;
    if (padding > 0) {
      this.parts.push(new Uint8Array(padding));
      this.lengthValue += padding;
    }
  }

  toUint8Array(): Uint8Array {
    const out = new Uint8Array(this.lengthValue);
    let offset = 0;
    for (const part of this.parts) {
      out.set(part, offset);
      offset += part.byteLength;
    }
    return out;
  }
}

const COMPONENT_FLOAT = 5126;
const COMPONENT_UNSIGNED_SHORT = 5123;
const COMPONENT_UNSIGNED_INT = 5125;
const TARGET_ARRAY_BUFFER = 34962;
const TARGET_ELEMENT_ARRAY_BUFFER = 34963;

function componentInfo(array: ArrayBufferView): { componentType: number; componentBytes: number } {
  if (array instanceof Float32Array) return { componentType: COMPONENT_FLOAT, componentBytes: 4 };
  if (array instanceof Uint16Array) return { componentType: COMPONENT_UNSIGNED_SHORT, componentBytes: 2 };
  if (array instanceof Uint32Array) return { componentType: COMPONENT_UNSIGNED_INT, componentBytes: 4 };
  throw new Error('暂不支持的 GLB 二进制数组类型');
}

function typeCount(type: AccessorType): number {
  switch (type) {
    case 'SCALAR': return 1;
    case 'VEC3': return 3;
    case 'VEC4': return 4;
    case 'MAT4': return 16;
  }
}

function bounds(array: ArrayLike<number>, stride: number, count: number): { min: number[]; max: number[] } {
  const min = new Array(stride).fill(Infinity);
  const max = new Array(stride).fill(-Infinity);
  for (let i = 0; i < count; i++) {
    for (let c = 0; c < stride; c++) {
      const v = array[i * stride + c];
      min[c] = Math.min(min[c], v);
      max[c] = Math.max(max[c], v);
    }
  }
  return { min, max };
}

function assertSingleRoot(skeleton: Skeleton): string {
  const roots = skeleton.boneIds.filter((id) => skeleton.parentIndex.get(id) === null);
  if (roots.length !== 1) throw new Error('GLB 导出要求单根 Skeleton，当前顶层骨数量: ' + roots.length);
  return roots[0];
}

function inverseBindMatrices(skeleton: Skeleton): Float32Array {
  const out = new Float32Array(skeleton.evalOrder.length * 16);
  skeleton.evalOrder.forEach((id, index) => {
    const elements = skeleton.inverseBindMatrix(id).elements as readonly number[];
    if (!elements.every(Number.isFinite)) throw new Error('骨骼 ' + id + ' 逆绑定矩阵含非法数值');
    out.set(elements, index * 16);
  });
  return out;
}

function padChunk(chunk: Uint8Array, fill: number): Uint8Array {
  const padding = (4 - (chunk.byteLength % 4)) % 4;
  if (padding === 0) return chunk;
  const out = new Uint8Array(chunk.byteLength + padding);
  out.set(chunk);
  out.fill(fill, chunk.byteLength);
  return out;
}

/** 编码自包含 glTF 2.0 GLB。 */
export function encodeCharacterGlb(
  skeleton: Skeleton,
  mesh: TriangleMesh,
  clips?: readonly AnimationClip[],
): ArrayBuffer;
export function encodeCharacterGlb(asset: GlbCharacterAsset): ArrayBuffer;
export function encodeCharacterGlb(
  assetOrSkeleton: GlbCharacterAsset | Skeleton,
  mesh?: TriangleMesh,
  clips?: readonly AnimationClip[],
): ArrayBuffer {
  const asset: GlbCharacterAsset = isSkeletonLike(assetOrSkeleton)
    ? {
      skeleton: assetOrSkeleton,
      mesh: mesh ?? ((): never => { throw new Error('GLB 导出缺少 mesh'); })(),
      clips: clips ?? [],
    }
    : assetOrSkeleton;
  const skeleton = asset.skeleton;
  assertSingleRoot(skeleton);
  const preparedMesh: PreparedTriangleMesh = prepareTriangleMesh(skeleton, asset.mesh);
  const meshNodeIndex = skeleton.evalOrder.length;
  const animations: GltfAnimation[] = prepareGlbAnimations(
    skeleton,
    asset.clips,
    meshNodeIndex,
    preparedMesh.morphTargets,
  );

  const binary = new BinaryWriter();
  const bufferViews: GltfBufferView[] = [];
  const accessors: GltfAccessor[] = [];

  const addView = (array: ArrayBufferView, target?: number): number => {
    const info = componentInfo(array);
    const range = binary.addArray(array, info.componentBytes);
    bufferViews.push({ buffer: 0, ...range, ...(target === undefined ? {} : { target }) });
    return bufferViews.length - 1;
  };
  const addAccessor = (
    array: ArrayBufferView & ArrayLike<number>,
    type: AccessorType,
    target?: number,
    includeBounds = false,
  ): number => {
    const info = componentInfo(array);
    const count = array.length / typeCount(type);
    const bufferView = addView(array, target);
    const accessor: GltfAccessor = {
      bufferView,
      componentType: info.componentType,
      count,
      type,
    };
    if (includeBounds) Object.assign(accessor, bounds(array, typeCount(type), count));
    accessors.push(accessor);
    return accessors.length - 1;
  };

  const ibmAccessor = addAccessor(inverseBindMatrices(skeleton), 'MAT4');
  const positionAccessor = addAccessor(preparedMesh.positions, 'VEC3', TARGET_ARRAY_BUFFER, true);
  const indexAccessor = addAccessor(preparedMesh.indices, 'SCALAR', TARGET_ELEMENT_ARRAY_BUFFER);
  const jointsAccessor = addAccessor(preparedMesh.joints, 'VEC4', TARGET_ARRAY_BUFFER);
  const weightsAccessor = addAccessor(preparedMesh.weights, 'VEC4', TARGET_ARRAY_BUFFER);
  const morphTargetAccessors = preparedMesh.morphTargets.displacements.map((displacements) =>
    addAccessor(displacements, 'VEC3', TARGET_ARRAY_BUFFER, true));

  const animationData: {
    animation: GltfAnimation;
    samplers: { input: number; output: number }[];
  }[] = [];
  for (const animation of animations) {
    const samplers: { input: number; output: number }[] = [];
    for (const channel of animation.channels) {
      const stride = channel.path === 'rotation'
        ? 4
        : channel.path === 'translation' || channel.path === 'scale'
          ? 3
          : channel.valueSize ?? 1;
      const input = addAccessor(channel.times, 'SCALAR', undefined, true);
      const outputType = channel.path === 'weights' ? 'SCALAR' : stride === 4 ? 'VEC4' : 'VEC3';
      const output = addAccessor(channel.values, outputType);
      samplers.push({ input, output });
    }
    animationData.push({ animation, samplers });
  }

  const nodeIndex = new Map(skeleton.evalOrder.map((id, index) => [id, index]));
  const childrenOf = new Map<string, string[]>();
  for (const id of skeleton.evalOrder) childrenOf.set(id, []);
  for (const id of skeleton.evalOrder) {
    const parent = skeleton.parentIndex.get(id);
    if (parent !== null && parent !== undefined) childrenOf.get(parent)!.push(id);
  }

  const nodes: GltfNode[] = skeleton.evalOrder.map((id) => {
    const bind = skeleton.bindLocalTransform(id);
    const children = childrenOf.get(id)!.map((child) => nodeIndex.get(child)!);
    return {
      name: id,
      ...(children.length > 0 ? { children } : {}),
      translation: [bind.translation[0], bind.translation[1], bind.translation[2]],
      rotation: [bind.rotation[0], bind.rotation[1], bind.rotation[2], bind.rotation[3]],
      scale: [bind.scale[0], bind.scale[1], bind.scale[2]],
    };
  });
  const rootIndex = nodeIndex.get(assertSingleRoot(skeleton))!;

  const hasMorphTargets = preparedMesh.morphTargets.targets.length > 0;
  const meshes = [{
    name: preparedMesh.name,
    ...(hasMorphTargets ? {
      weights: Array.from(preparedMesh.morphTargets.defaultWeights),
      extras: { targetNames: preparedMesh.morphTargets.targets.map((target) => target.name) },
    } : {}),
    primitives: [{
      attributes: {
        POSITION: positionAccessor,
        JOINTS_0: jointsAccessor,
        WEIGHTS_0: weightsAccessor,
      },
      indices: indexAccessor,
      mode: 4,
      ...(morphTargetAccessors.length > 0 ? {
        targets: morphTargetAccessors.map((POSITION) => ({ POSITION })),
      } : {}),
    }],
  }];
  nodes.push({
    name: preparedMesh.name,
    mesh: 0,
    skin: 0,
  });
  const skins = [{
    name: 'skin',
    inverseBindMatrices: ibmAccessor,
    skeleton: rootIndex,
    joints: skeleton.evalOrder.map((id) => nodeIndex.get(id)!),
  }];

  const gltfAnimations: {
    name: string;
    samplers: { input: number; output: number; interpolation: 'LINEAR' }[];
    channels: { sampler: number; target: { node: number; path: string } }[];
  }[] = [];
  for (const { animation, samplers } of animationData) {
    const gltfSamplers = samplers.map((s) => ({ ...s, interpolation: 'LINEAR' as const }));
    const gltfChannels = animation.channels.map((channel, index) => ({
      sampler: index,
      target: { node: channel.nodeIndex, path: channel.path },
    }));
    gltfAnimations.push({ name: animation.name, samplers: gltfSamplers, channels: gltfChannels });
  }

  binary.align(4);
  const bin = binary.toUint8Array();
  const gltf: Record<string, unknown> = {
    asset: { version: '2.0', generator: 'skeletal-animation-038' },
    scene: 0,
    scenes: [{ name: 'scene', nodes: [rootIndex, meshNodeIndex] }],
    nodes,
    meshes,
    skins,
    ...(gltfAnimations.length > 0 ? { animations: gltfAnimations } : {}),
    accessors,
    bufferViews,
    buffers: [{ byteLength: bin.byteLength }],
  };

  const jsonChunk = padChunk(new TextEncoder().encode(JSON.stringify(gltf)), 0x20);
  const binChunk = padChunk(bin, 0x00);
  const totalLength = 12 + 8 + jsonChunk.byteLength + 8 + binChunk.byteLength;
  const out = new ArrayBuffer(totalLength);
  const view = new DataView(out);
  const bytes = new Uint8Array(out);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, totalLength, true);
  let offset = 12;
  view.setUint32(offset, jsonChunk.byteLength, true);
  view.setUint32(offset + 4, 0x4e4f534a, true);
  bytes.set(jsonChunk, offset + 8);
  offset += 8 + jsonChunk.byteLength;
  view.setUint32(offset, binChunk.byteLength, true);
  view.setUint32(offset + 4, 0x004e4942, true);
  bytes.set(binChunk, offset + 8);
  return out;
}

export function exportCharacterGlb(
  skeleton: Skeleton,
  mesh: TriangleMesh,
  clips?: readonly AnimationClip[],
): ArrayBuffer;
export function exportCharacterGlb(asset: GlbCharacterAsset): ArrayBuffer;
export function exportCharacterGlb(
  assetOrSkeleton: GlbCharacterAsset | Skeleton,
  mesh?: TriangleMesh,
  clips?: readonly AnimationClip[],
): ArrayBuffer {
  if (isSkeletonLike(assetOrSkeleton)) {
    return encodeCharacterGlb(assetOrSkeleton, mesh!, clips);
  }
  return encodeCharacterGlb(assetOrSkeleton);
}
