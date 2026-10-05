/** 片段方向：正放或倒放。 */
export type Direction = 'forward' | 'reverse';

/** 调用方提供的剪辑片段。 */
export interface SegmentInput {
  /** 稳定的原素材标识。 */
  readonly sourceId: string;
  /** 原素材起边界（帧边界，整数）。 */
  readonly sourceStart: number;
  /** 原素材止边界（帧边界，整数），必须大于 sourceStart。 */
  readonly sourceEnd: number;
  /** 成片长度（帧数），正整数。 */
  readonly duration: number;
  /** 正放或倒放。 */
  readonly direction: Direction;
}

/** 调用方提供的批注。 */
export interface AnnotationInput {
  /** 稳定的批注标识。 */
  readonly id: string;
  /** 旧版成片起始帧（含）。 */
  readonly startFrame: number;
  /**
   * 旧版成片结束帧（不含）。
   * 与 startFrame 相等时表示单点批注，按覆盖 [startFrame, startFrame+1) 处理。
   */
  readonly endFrame: number;
}

/** 新版成片上的整数帧区间，左闭右开。 */
export interface FrameRange {
  readonly startFrame: number;
  readonly endFrame: number;
}

/** 一条旧批注的迁移结果；ranges 为空表示新版中无落点。 */
export interface AnnotationMigration {
  readonly annotationId: string;
  readonly ranges: readonly FrameRange[];
}

/** 一次迁移预览的完整结果。 */
export interface MigrationPreview {
  readonly fromVersionId: string;
  readonly toVersionId: string;
  readonly results: readonly AnnotationMigration[];
}
