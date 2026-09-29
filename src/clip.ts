import type { AnimationClip, BoneTrack, Keyframe, MorphTarget, Quat, Vec3 } from './types.js';
import type { Skeleton } from './skeleton.js';
import { validateMorphTracks } from './morph.js';

const QUAT_TOLERANCE = 1e-3;

function checkKeys<T>(keys: readonly Keyframe<T>[], duration: number, what: string): void {
  let prev = -Infinity;
  for (const k of keys) {
    if (!Number.isFinite(k.time)) throw new Error(what + ' 关键帧时间非法');
    if (k.time < 0 || k.time > duration) {
      throw new Error(what + ' 关键帧时间 ' + k.time + ' 超出片段范围 [0, ' + duration + ']');
    }
    if (k.time <= prev) throw new Error(what + ' 关键帧时间必须严格递增');
    prev = k.time;
  }
}

function checkVec3(v: Vec3, what: string): void {
  if (!v.every(Number.isFinite)) throw new Error(what + ' 含非法数值');
}

function checkQuat(q: Quat, what: string): void {
  checkVec3(q as unknown as Vec3, what);
  const len = Math.hypot(q[0], q[1], q[2], q[3]);
  if (Math.abs(len - 1) > QUAT_TOLERANCE) throw new Error(what + ' 不是单位四元数');
}

function checkScale(s: Vec3, what: string): void {
  checkVec3(s, what);
  if (s[0] <= 0 || s[1] <= 0 || s[2] <= 0) throw new Error(what + ' 缩放分量必须为正');
}

/** 校验动画片段与骨架的兼容性，非法时抛错。 */
export function validateClip(
  clip: AnimationClip,
  skeleton: Skeleton,
  morphTargets?: readonly MorphTarget[],
): void {
  if (!Number.isFinite(clip.duration) || clip.duration <= 0) {
    throw new Error('片段 ' + clip.name + ' 时长必须为正数');
  }
  const seen = new Set<string>();
  for (const track of clip.tracks) {
    if (!skeleton.hasBone(track.boneId)) {
      throw new Error('片段 ' + clip.name + ' 引用了未知骨骼: ' + track.boneId);
    }
    if (seen.has(track.boneId)) {
      throw new Error('片段 ' + clip.name + ' 存在重复轨道: ' + track.boneId);
    }
    seen.add(track.boneId);
    const what = '片段 ' + clip.name + ' 骨骼 ' + track.boneId;
    checkKeys(track.translations ?? [], clip.duration, what + ' 平移');
    checkKeys(track.rotations ?? [], clip.duration, what + ' 旋转');
    checkKeys(track.scales ?? [], clip.duration, what + ' 缩放');
    for (const k of track.translations ?? []) checkVec3(k.value, what + ' 平移');
    for (const k of track.rotations ?? []) checkQuat(k.value, what + ' 旋转');
    for (const k of track.scales ?? []) checkScale(k.value, what + ' 缩放');
  }
  if (morphTargets) validateMorphTracks(clip, morphTargets);
}

/** 在严格递增的关键帧序列上按时间定位并插值。两端外夹取端值。 */
export function sampleKeys<T>(
  keys: readonly Keyframe<T>[],
  time: number,
  lerp: (a: T, b: T, t: number) => T,
): T | undefined {
  if (keys.length === 0) return undefined;
  if (time <= keys[0].time) return keys[0].value;
  const last = keys[keys.length - 1];
  if (time >= last.time) return last.value;
  let lo = 0;
  let hi = keys.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (keys[mid].time <= time) lo = mid; else hi = mid;
  }
  const a = keys[lo];
  const b = keys[hi];
  const t = (time - a.time) / (b.time - a.time);
  return lerp(a.value, b.value, t);
}
