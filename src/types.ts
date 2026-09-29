/** 三维向量，右手坐标系。 */
export type Vec3 = readonly [number, number, number];
/** 单位四元数，[x, y, z, w]。 */
export type Quat = readonly [number, number, number, number];

/** 单根骨骼的绑定姿态定义（输入允许乱序）。 */
export interface BoneSpec {
  /** 唯一骨骼 ID。 */
  readonly id: string;
  /** 父骨骼 ID；根骨骼为 null。 */
  readonly parentId: string | null;
  /** 绑定姿态局部平移。 */
  readonly translation: Vec3;
  /** 绑定姿态局部旋转（单位四元数）。 */
  readonly rotation: Quat;
  /** 绑定姿态局部缩放（各分量必须为正）。 */
  readonly scale: Vec3;
}

/** 关键帧。 */
export interface Keyframe<T> {
  /** 位于片段 [0, duration] 内，同一轨道内严格递增。 */
  readonly time: number;
  readonly value: T;
}

/** 单根骨骼的动画轨道；缺失的通道回退到绑定值。 */
export interface BoneTrack {
  readonly boneId: string;
  readonly translations?: readonly Keyframe<Vec3>[];
  readonly rotations?: readonly Keyframe<Quat>[];
  readonly scales?: readonly Keyframe<Vec3>[];
}

/** 三角网格形变目标；位移与绑定姿态顶点一一对应。 */
export interface MorphTarget {
  /** 同一网格内唯一的目标名称。 */
  readonly name: string;
  /** 角色空间位移，长度必须等于绑定顶点数。 */
  readonly displacements: readonly Vec3[];
  /** 默认权重，范围 [0, 1]；缺省为 0。 */
  readonly defaultWeight?: number;
}

/** 按形变目标名称索引的标量权重轨道。 */
export interface MorphWeightTrack {
  readonly targetName: string;
  readonly keys: readonly Keyframe<number>[];
}

/** 动画片段。 */
export interface AnimationClip {
  readonly name: string;
  /** 正时长（秒）。 */
  readonly duration: number;
  readonly tracks: readonly BoneTrack[];
  /** 可选形变目标权重轨道；与骨骼通道共用同一时钟。 */
  readonly morphTracks?: readonly MorphWeightTrack[];
}

/** 播放模式：once 停在末帧；loop 按时长取模。 */
export type LoopMode = 'once' | 'loop';

/** 一个动画层的采样参数。 */
export interface LayerSample {
  readonly clip: AnimationClip;
  /** 非负采样时间（秒）。 */
  readonly time: number;
  readonly loop: LoopMode;
}

/** 覆盖层：在基础层之上按权重混合。 */
export interface OverlayLayer extends LayerSample {
  /** 覆盖强度，[0, 1]。 */
  readonly strength: number;
  /**
   * 骨骼遮罩权重（[0, 1]）。未指定的骨骼继承最近祖先的权重，
   * 根默认 0；显式 0 会屏蔽继承。
   */
  readonly mask?: Readonly<Record<string, number>>;
}

/** 单骨骼局部姿态。 */
export interface LocalTransform {
  readonly translation: Vec3;
  readonly rotation: Quat;
  readonly scale: Vec3;
}

/** 每顶点蒙皮权重（至多 4 个骨骼影响）。 */
export interface SkinInfluence {
  readonly boneId: string;
  /** 非负权重。 */
  readonly weight: number;
}

/** 绑定姿态角色空间中的三角网格。 */
export interface TriangleMesh {
  /** 可选网格名称，会写入 glTF node/mesh 名称。 */
  readonly name?: string;
  /** 绑定姿态顶点位置。 */
  readonly positions: readonly Vec3[];
  /** 三角形索引；长度必须为 3 的倍数。 */
  readonly indices: readonly number[];
  /** 与 positions 一一对应的蒙皮权重；每顶点至少一个、至多四个非零影响。 */
  readonly weights: readonly (readonly SkinInfluence[])[];
  /** 可选形变目标，数组顺序即 glTF morph target 顺序。 */
  readonly morphTargets?: readonly MorphTarget[];
}

/** 可导出的骨骼蒙皮角色资产。 */
export interface GlbCharacterAsset {
  readonly skeleton: import('./skeleton.js').Skeleton;
  readonly mesh: TriangleMesh;
  readonly clips: readonly AnimationClip[];
}

/** 两骨骼 IK 链：rootJoint -> middleJoint -> endJoint，必须直接相连。 */
export interface TwoBoneIkChain {
  readonly rootJointId: string;
  readonly middleJointId: string;
  readonly endJointId: string;
}

/** 两骨骼 IK 求解请求。坐标均为角色空间。 */
export interface TwoBoneIkRequest extends TwoBoneIkChain {
  /** 末端期望贴合的角色空间目标点。 */
  readonly target: Vec3;
  /** 弯曲参考点；中间关节会朝该点相对 root-target 方向的一侧弯曲。 */
  readonly bendReference: Vec3;
  /** 约束权重，0 保持原姿态，1 完整应用，中间值按最短弧插值。 */
  readonly weight: number;
}

/** 两骨骼 IK 求解结果。 */
export interface TwoBoneIkResult {
  /** 应用约束后的完整局部姿态。 */
  readonly localPose: Map<string, LocalTransform>;
  /** 由求解后局部姿态重新生成的完整世界矩阵。 */
  readonly worldMatrices: Map<string, import('three').Matrix4>;
  /** 原始目标是否在两段骨骼的可达范围内。 */
  readonly reachable: boolean;
  /** 应用当前权重后，实际末端位置到原始目标点的距离。 */
  readonly distanceToTarget: number;
  /** 应用当前权重后的末端实际角色空间位置。 */
  readonly actualEndPosition: Vec3;
  /** 满权重求解时夹取后的可达目标点。 */
  readonly clampedTarget: Vec3;
}

/** 刚体变换：仅平移与单位四元数旋转（缩放恒为单位 1）。 */
export interface RigidTransform {
  readonly translation: Vec3;
  readonly rotation: Quat;
}

/** 根运动播放实例的覆盖层参数；采样时间自动与播放实例同步。 */
export interface PlaybackOverlay {
  readonly clip: AnimationClip;
  /** 覆盖强度，[0, 1]。 */
  readonly strength: number;
  /** 覆盖层播放模式，缺省与基础层一致。 */
  readonly loop?: LoopMode;
  /**
   * 骨骼遮罩权重（[0, 1]）。顶层根骨骼恒为 0：
   * 覆盖层可影响其他骨骼，但不能改变根或贡献根运动。
   */
  readonly mask?: Readonly<Record<string, number>>;
}

/** 根运动播放实例单帧求值结果。 */
export interface PlaybackFrame {
  /** 当前角色刚体变换（世界空间）。 */
  readonly character: RigidTransform;
  /** 由 character 组合出的角色世界矩阵（单位缩放）。 */
  readonly characterMatrix: import('three').Matrix4;
  /** 根被钉在片段起始变换后的完整局部姿态。 */
  readonly localPose: Map<string, LocalTransform>;
  /** 角色空间骨骼矩阵（由局部姿态按层级累乘）。 */
  readonly worldMatrices: Map<string, import('three').Matrix4>;
  /** 累计播放时间（秒，loop 下可超过片段时长）。 */
  readonly time: number;
  /** 映射到片段内的采样时间（秒）。 */
  readonly clipTime: number;
  /** once 模式下是否已停在末帧。 */
  readonly finished: boolean;
}

/** 世界空间两骨骼 IK 请求；坐标均为世界空间。 */
export interface WorldTwoBoneIkRequest extends TwoBoneIkChain {
  /** 末端期望贴合的世界目标点。 */
  readonly worldTarget: Vec3;
  /** 世界空间弯曲参考点。 */
  readonly worldBendReference: Vec3;
  /** 当前角色世界刚体矩阵（仅允许单位缩放）。 */
  readonly characterMatrix: import('three').Matrix4;
  /** 约束权重，0 保持原姿态，1 完整应用。 */
  readonly weight: number;
}

/** 世界空间两骨骼 IK 结果。 */
export interface WorldTwoBoneIkResult {
  /** 应用约束后的完整局部姿态（角色空间）。 */
  readonly localPose: Map<string, LocalTransform>;
  /** 求解后角色空间骨骼矩阵。 */
  readonly worldMatrices: Map<string, import('three').Matrix4>;
  /** 世界末端实际位置。 */
  readonly worldEndPosition: Vec3;
  /** 角色空间末端实际位置。 */
  readonly actualEndPosition: Vec3;
  /** 原始世界目标是否可达。 */
  readonly reachable: boolean;
  /** 世界末端到世界目标的距离。 */
  readonly distanceToTarget: number;
}

/** 单根骨骼映射条目：源骨骼 ID 一一对应到目标骨骼 ID。 */
export interface RetargetBoneMapping {
  readonly sourceBoneId: string;
  readonly targetBoneId: string;
}

/** 构造动作重定向可复用计划的参数。 */
export interface RetargetPlanOptions {
  readonly source: import('./skeleton.js').Skeleton;
  readonly target: import('./skeleton.js').Skeleton;
  /**
   * 根相对应的一一骨骼映射：必须包含两侧的顶层根，且保持祖先/后代次序。
   * 目标允许插入未映射的中间骨（映射骨之间可隔着目标独有骨骼）。
   */
  readonly mapping: readonly RetargetBoneMapping[];
}

/** 把源当前姿态烘焙为目标片段的参数。 */
export interface RetargetBakeOptions {
  /** 严格递增的采样时刻；必须从 0 开始并以源片段时长结束（含两端）。 */
  readonly sampleTimes: readonly number[];
  /** 根位移倍率（有限正数）；缺省 1。 */
  readonly rootTranslationScale?: number;
  /** 目标片段名称；缺省在源片段名后加 -retarget 后缀。 */
  readonly name?: string;
  /** 源片段循环模式；缺省 'loop'。仅影响采样时刻的解释。 */
  readonly loop?: LoopMode;
}
