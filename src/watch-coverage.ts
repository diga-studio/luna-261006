import { ScopeKey, Segment, WatchProgress } from "./types";

interface ActiveSegment {
  readonly version: number;
  readonly startMs: number;
  readonly endMs: number;
}

/** 单个统计对象（租户 + 档案 + 影片）的核算状态。 */
class ScopeState {
  /** 每个片段标识见过的最高版本号（无论当前是否有效）。 */
  private readonly highestVersion = new Map<string, number>();
  /** 当前生效的片段。 */
  private readonly active = new Map<string, ActiveSegment>();

  upsert(segment: Segment): void {
    const seen = this.highestVersion.get(segment.segmentId) ?? 0;
    if (segment.version <= seen) {
      return;
    }
    this.highestVersion.set(segment.segmentId, segment.version);
    this.active.set(segment.segmentId, {
      version: segment.version,
      startMs: segment.startMs,
      endMs: segment.endMs,
    });
  }

  revoke(segmentId: string, version: number): void {
    const seen = this.highestVersion.get(segmentId) ?? 0;
    if (version <= seen) {
      return;
    }
    this.highestVersion.set(segmentId, version);
    this.active.delete(segmentId);
  }

  coveredMs(): number {
    const intervals: ActiveSegment[] = [];
    for (const seg of this.active.values()) {
      intervals.push(seg);
    }
    intervals.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

    let total = 0;
    let curStart = -1;
    let curEnd = -1;
    for (const iv of intervals) {
      if (iv.startMs > curEnd) {
        if (curEnd >= 0) {
          total += curEnd - curStart;
        }
        curStart = iv.startMs;
        curEnd = iv.endMs;
      } else if (iv.endMs > curEnd) {
        curEnd = iv.endMs;
      }
    }
    if (curEnd >= 0) {
      total += curEnd - curStart;
    }
    return total;
  }
}

const KEY_SEPARATOR = String.fromCharCode(0);

function scopeId(key: ScopeKey): string {
  return [key.tenantId, key.profileId, key.videoId].join(KEY_SEPARATOR);
}

/**
 * 观看覆盖核算器：进程内存中按统计对象隔离地核算有效覆盖。
 */
export class WatchCoverageLedger {
  private readonly scopes = new Map<string, ScopeState>();

  /**
   * 登记或修订片段。修订是整体替换该标识的旧区间。
   * 较低版本与同版本重放不改变结果。
   */
  upsertSegment(
    key: ScopeKey,
    videoDurationMs: number,
    segment: Segment
  ): void {
    this.scopeFor(key).upsert(segment);
  }

  /**
   * 撤销片段：只移除该标识的贡献，不抹掉其他片段的覆盖。
   * 撤销可以先于登记到达；之后更高版本的登记可重新生效。
   */
  revokeSegment(
    key: ScopeKey,
    videoDurationMs: number,
    segmentId: string,
    version: number
  ): void {
    this.scopeFor(key).revoke(segmentId, version);
  }

  /** 查询当前有效片段区间并集的总毫秒数与完成状态。 */
  getProgress(key: ScopeKey, videoDurationMs: number): WatchProgress {
    const scope = this.scopes.get(scopeId(key));
    const coveredMs = scope === undefined ? 0 : scope.coveredMs();
    // 90% 阈值用整数比较，不四舍五入：covered / duration >= 9 / 10
    const completed = coveredMs * 10 >= videoDurationMs * 9;
    return { coveredMs, completed };
  }

  private scopeFor(key: ScopeKey): ScopeState {
    const id = scopeId(key);
    let scope = this.scopes.get(id);
    if (scope === undefined) {
      scope = new ScopeState();
      this.scopes.set(id, scope);
    }
    return scope;
  }
}
