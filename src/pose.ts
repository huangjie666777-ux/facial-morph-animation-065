import { Quaternion, Vector3 } from 'three';
import type {
  AnimationClip,
  LayerSample,
  LocalTransform,
  LoopMode,
  OverlayLayer,
  Quat,
  Vec3,
} from './types.js';
import { sampleKeys, validateClip } from './clip.js';
import { computeWorldMatrices } from './skeleton.js';
import type { Skeleton } from './skeleton.js';
import type { Matrix4 } from 'three';

const lerpVec3 = (a: Vec3, b: Vec3, t: number): Vec3 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

/** 最短弧球面插值，结果为单位四元数。 */
export function slerpQuat(a: Quat, b: Quat, t: number): Quat {
  const qa = new Quaternion(a[0], a[1], a[2], a[3]);
  const qb = new Quaternion(b[0], b[1], b[2], b[3]);
  // three 的 slerpFlat 在点积为负时自动取反，保证最短弧。
  qa.slerp(qb, t).normalize();
  return [qa.x, qa.y, qa.z, qa.w];
}

/** 依据播放模式把非负时间映射到片段内。 */
export function resolveClipTime(time: number, duration: number, loop: LoopMode): number {
  if (!Number.isFinite(time) || time < 0) {
    throw new Error('采样时间必须为非负有限数: ' + String(time));
  }
  if (loop === 'loop') {
    const t = time % duration;
    return t < 0 ? t + duration : t;
  }
  return Math.min(time, duration);
}

/** 采样片段得到完整局部姿态；缺失轨道回退到绑定值。 */
export function sampleClip(
  clip: AnimationClip,
  skeleton: Skeleton | undefined,
  time: number,
  loop: LoopMode,
): Map<string, LocalTransform> {
  validateClip(clip, skeleton);
  const t = resolveClipTime(time, clip.duration, loop);
  const tracks = new Map(clip.tracks.map((tr) => [tr.boneId, tr]));
  const pose = new Map<string, LocalTransform>();
  for (const id of skeleton?.boneIds ?? []) {
    const bind = skeleton!.bindLocalTransform(id);
    const track = tracks.get(id);
    pose.set(id, {
      translation: (track && sampleKeys(track.translations ?? [], t, lerpVec3)) ?? bind.translation,
      rotation: (track && sampleKeys(track.rotations ?? [], t, slerpQuat)) ?? bind.rotation,
      scale: (track && sampleKeys(track.scales ?? [], t, lerpVec3)) ?? bind.scale,
    });
  }
  return pose;
}

/** 计算遮罩权重：未指定骨骼继承最近祖先，根默认 0，显式 0 屏蔽继承。 */
export function resolveMaskWeights(
  skeleton: Skeleton,
  mask: Readonly<Record<string, number>>,
): Map<string, number> {
  for (const [id, w] of Object.entries(mask)) {
    if (!skeleton.hasBone(id)) throw new Error('遮罩引用了未知骨骼: ' + id);
    if (!Number.isFinite(w) || w < 0 || w > 1) {
      throw new Error('遮罩权重必须在 [0, 1]: ' + id + ' = ' + String(w));
    }
  }
  const weights = new Map<string, number>();
  for (const id of skeleton.evalOrder) {
    if (Object.prototype.hasOwnProperty.call(mask, id)) {
      weights.set(id, mask[id]);
    } else {
      const parent = skeleton.parentIndex.get(id)!;
      weights.set(id, parent === null ? 0 : weights.get(parent)!);
    }
  }
  return weights;
}

/** 按骨骼权重把覆盖姿态混入基础姿态（局部空间）。 */
export function blendLocalPoses(
  base: ReadonlyMap<string, LocalTransform>,
  overlay: ReadonlyMap<string, LocalTransform>,
  weights: ReadonlyMap<string, number>,
): Map<string, LocalTransform> {
  const out = new Map<string, LocalTransform>();
  for (const [id, b] of base) {
    const o = overlay.get(id);
    const w = weights.get(id) ?? 0;
    if (!o || w === 0) {
      out.set(id, b);
      continue;
    }
    if (w === 1) {
      out.set(id, o);
      continue;
    }
    out.set(id, {
      translation: lerpVec3(b.translation, o.translation, w),
      rotation: slerpQuat(b.rotation, o.rotation, w),
      scale: lerpVec3(b.scale, o.scale, w),
    });
  }
  return out;
}

/** 分层混合求值结果。 */
export interface EvaluatedPose {
  /** 混合后的局部姿态。 */
  readonly localPose: Map<string, LocalTransform>;
  /** 由混合局部姿态累乘得到的世界矩阵。 */
  readonly worldMatrices: Map<string, Matrix4>;
}

/**
 * 求值分层动画：基础层 + 可选覆盖层。
 * 覆盖层最终权重 = strength × 遮罩权重（无遮罩时所有骨骼为 1）。
 * 先在局部空间混合，再计算世界矩阵。
 */
export function evaluatePose(
  skeleton: Skeleton,
  base: LayerSample,
  overlay?: OverlayLayer,
): EvaluatedPose {
  const basePose = sampleClip(base.clip, skeleton, base.time, base.loop);
  let localPose = basePose;
  if (overlay) {
    if (!Number.isFinite(overlay.strength) || overlay.strength < 0 || overlay.strength > 1) {
      throw new Error('覆盖强度必须在 [0, 1]: ' + String(overlay.strength));
    }
    const overlayPose = sampleClip(overlay.clip, skeleton, overlay.time, overlay.loop);
    const maskWeights = overlay.mask
      ? resolveMaskWeights(skeleton, overlay.mask)
      : new Map(skeleton.boneIds.map((id) => [id, 1]));
    const weights = new Map<string, number>();
    for (const id of skeleton.boneIds) {
      weights.set(id, overlay.strength * maskWeights.get(id)!);
    }
    localPose = blendLocalPoses(basePose, overlayPose, weights);
  }
  return { localPose, worldMatrices: computeWorldMatrices(skeleton, localPose) };
}

/** 便捷导出：把局部姿态转换为 three 的 Vector3/Quaternion（示例与调试用）。 */
export function localTransformToThree(t: LocalTransform): {
  position: Vector3;
  quaternion: Quaternion;
  scale: Vector3;
} {
  return {
    position: new Vector3(...t.translation),
    quaternion: new Quaternion(...t.rotation),
    scale: new Vector3(...t.scale),
  };
}
