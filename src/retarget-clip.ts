import type {
  AnimationClip,
  BoneTrack,
  Keyframe,
  Quat,
  RetargetBakeOptions,
  Vec3,
} from './types.js';
import type { RetargetPlan } from './retarget-plan.js';
import { sampleClip } from './pose.js';
import { retargetPose } from './retarget-pose.js';

/**
 * 将源片段按调用方指定的严格递增采样时刻烘焙为目标骨架的 AnimationClip。
 *
 * 时刻必须从 0 开始、以源片段时长结束（含两端）且严格递增；终点直接按
 * 片段末帧采样，绝不折回首帧。每个采样点的姿态与 retargetPose 逐点转换
 * 完全一致。输出轨道使用目标骨 ID：映射骨输出旋转轨道，根额外输出平移
 * 轨道（根位移按倍率缩放）；不输出非根平移与缩放轨道（保持目标绑定骨长）。
 * 片段时长与源片段相同，可直接交给 RootMotionPlayer 播放根运动。
 * 不修改任何输入；返回片段中的关键帧值均为独立数组。
 */
export function bakeRetargetedClip(
  plan: RetargetPlan,
  sourceClip: AnimationClip,
  options: RetargetBakeOptions,
): AnimationClip {
  if (!options || !Array.isArray(options.sampleTimes)) {
    throw new Error('烘焙缺少采样时刻数组');
  }
  const times = options.sampleTimes;
  if (times.length < 2) throw new Error('烘焙至少需要两个采样时刻（含两端）');
  for (let i = 0; i < times.length; i++) {
    if (typeof times[i] !== 'number' || !Number.isFinite(times[i])) {
      throw new Error('采样时刻含非法数值: ' + String(times[i]));
    }
    if (i === 0 && times[i] !== 0) throw new Error('采样时刻必须从 0 开始');
    if (i > 0 && times[i] <= times[i - 1]) {
      throw new Error('采样时刻必须严格递增');
    }
  }
  if (times[times.length - 1] !== sourceClip.duration) {
    throw new Error(
      '采样时刻必须以源片段时长 ' + sourceClip.duration + ' 结束，实际为 '
      + String(times[times.length - 1]),
    );
  }
  const scale = options.rootTranslationScale ?? 1;
  if (typeof scale !== 'number' || !Number.isFinite(scale) || scale <= 0) {
    throw new Error('根位移倍率必须为有限正数: ' + String(scale));
  }
  // 烘焙始终按片段实际时刻采样（once 夹取语义）：终点取末帧，
  // 绝不因 loop 取模折回首帧；采样时刻已被限制在 [0, duration]。
  const loop = 'once' as const;

  const { target } = plan;
  const rotationKeys = new Map<string, Keyframe<Quat>[]>();
  let translationKeys: Keyframe<Vec3>[] = [];
  for (const { targetBoneId } of plan.mappings) {
    rotationKeys.set(targetBoneId, []);
  }

  for (const time of times) {
    // 'once' 在终点夹取到末帧；loop 下 0 与 duration 通常姿态相同，
    // 但这里始终按给定时刻直接采样，终点不会折回首帧。
    const sourcePose = sampleClip(sourceClip, plan.source, time, loop);
    const pose = retargetPose(plan, sourcePose, scale);
    for (const [boneId, keys] of rotationKeys) {
      const r = pose.get(boneId)!.rotation;
      keys.push({ time, value: [r[0], r[1], r[2], r[3]] });
    }
    const rt = pose.get(plan.targetRootId)!.translation;
    translationKeys.push({ time, value: [rt[0], rt[1], rt[2]] });
  }

  const tracks: BoneTrack[] = [];
  for (const id of target.evalOrder) {
    const keys = rotationKeys.get(id);
    if (!keys) continue;
    if (id === plan.targetRootId) {
      tracks.push({ boneId: id, rotations: keys, translations: translationKeys });
    } else {
      tracks.push({ boneId: id, rotations: keys });
    }
  }

  return {
    name: options.name ?? sourceClip.name + '-retarget',
    duration: sourceClip.duration,
    tracks,
    ...(sourceClip.morphTracks ? { morphTracks: sourceClip.morphTracks } : {}),
  };
}
