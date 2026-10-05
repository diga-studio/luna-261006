/**
 * 统计对象身份：租户 + 用户档案 + 影片。
 * 由调用方提供且可信；同一影片的总时长固定。
 */
export interface ScopeKey {
  readonly tenantId: string;
  readonly profileId: string;
  readonly videoId: string;
}

/** 播放片段：区间 [startMs, endMs)，含起点、不含终点。 */
export interface Segment {
  readonly segmentId: string;
  /** 正整数版本号；同一标识只有最高版本生效。 */
  readonly version: number;
  readonly startMs: number;
  readonly endMs: number;
}

/** 观看进度查询结果。 */
export interface WatchProgress {
  /** 当前有效片段区间并集的总毫秒数。 */
  readonly coveredMs: number;
  /** 覆盖量达到影片总时长 90% 即为完成（不四舍五入）。 */
  readonly completed: boolean;
}
