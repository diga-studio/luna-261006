/** 统计对象身份：租户 + 用户档案 + 影片。 */
export interface ObjectKey {
  tenantId: string;
  profileId: string;
  videoId: string;
}

/** 播放片段。区间 [startMs, endMs) 含起点不含终点，位于影片范围内且长度大于零。 */
export interface Segment {
  segmentId: string;
  version: number;
  startMs: number;
  endMs: number;
}

/** 观看进度查询结果。 */
export interface WatchProgress {
  coveredMs: number;
  completed: boolean;
}

export interface WatchCoverageService {
  /** 登记或修订片段。同一标识只有最高版本生效。 */
  upsertSegment(key: ObjectKey, totalDurationMs: number, segment: Segment): void;
  /** 撤销片段，只移除该标识的贡献。 */
  revokeSegment(key: ObjectKey, segmentId: string, version: number): void;
  /** 查询当前有效片段区间并集的总毫秒数与完成状态。 */
  getProgress(key: ObjectKey): WatchProgress;
}
