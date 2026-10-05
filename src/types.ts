/** 播放方向：正放从原素材起边界走向止边界，倒放相反。 */
export type Direction = 'forward' | 'reverse';

/**
 * 剪辑片段。片段在成片时间线上依次拼接、无空隙。
 * 所有帧编号均为 24fps 整数帧；边界与长度均为 JavaScript 安全整数。
 */
export interface ClipSegment {
  /** 稳定的原素材标识。 */
  readonly mediaId: string;
  /** 原素材起边界（含），整数帧。 */
  readonly sourceStartFrame: number;
  /** 原素材止边界（不含），整数帧，必须大于 sourceStartFrame。 */
  readonly sourceEndFrame: number;
  /** 正整数成片长度（帧数）。允许与原素材帧数不同（非整数倍速）。 */
  readonly timelineLength: number;
  /** 正放或倒放。 */
  readonly direction: Direction;
}

/**
 * 批注：覆盖旧版时间线的左闭右开帧区间 [startFrame, endFrame)。
 * 单点批注（startFrame === endFrame）按覆盖一个完整成片帧
 * [startFrame, startFrame + 1) 处理。
 */
export interface Annotation {
  /** 稳定的批注标识。 */
  readonly id: string;
  readonly startFrame: number;
  readonly endFrame: number;
}

/** 新版时间线上的左闭右开整数帧区间。 */
export interface FrameInterval {
  readonly startFrame: number;
  readonly endFrame: number;
}

/** 单条旧批注的迁移结果。intervals 按新版位置排序，重叠或相邻区间已合并。 */
export interface MigrationResult {
  readonly annotationId: string;
  readonly intervals: FrameInterval[];
}
