import { ObjectKey, Segment, WatchCoverageService, WatchProgress } from "./types";
import { Interval, unionLengthMs } from "./intervals";

interface SegmentState {
  /** 该标识见过的最高版本号（含登记与撤销）。 */
  lastVersion: number;
  /** 当前生效的区间；被撤销或从未登记时为 null。 */
  effective: Interval | null;
}

interface ObjectState {
  totalDurationMs: number;
  segments: Map<string, SegmentState>;
}

function objectId(key: ObjectKey): string {
  return JSON.stringify([key.tenantId, key.profileId, key.videoId]);
}

class WatchCoverageServiceImpl implements WatchCoverageService {
  private readonly objects = new Map<string, ObjectState>();

  upsertSegment(key: ObjectKey, totalDurationMs: number, segment: Segment): void {
    const state = this.getOrCreate(key, totalDurationMs);
    const existing = state.segments.get(segment.segmentId);
    if (existing !== undefined) {
      if (segment.version > existing.lastVersion) {
        existing.lastVersion = segment.version;
        existing.effective = { startMs: segment.startMs, endMs: segment.endMs };
      }
      return;
    }
    state.segments.set(segment.segmentId, {
      lastVersion: segment.version,
      effective: { startMs: segment.startMs, endMs: segment.endMs },
    });
  }

  revokeSegment(key: ObjectKey, segmentId: string, version: number): void {
    const state = this.getOrCreate(key, 0);
    const existing = state.segments.get(segmentId);
    if (existing === undefined) {
      state.segments.set(segmentId, { lastVersion: version, effective: null });
      return;
    }
    if (version >= existing.lastVersion) {
      existing.lastVersion = version;
      existing.effective = null;
    }
  }

  getProgress(key: ObjectKey): WatchProgress {
    const state = this.objects.get(objectId(key));
    if (state === undefined) {
      return { coveredMs: 0, completed: false };
    }
    const intervals: Interval[] = [];
    for (const segment of state.segments.values()) {
      if (segment.effective !== null) {
        intervals.push(segment.effective);
      }
    }
    const coveredMs = unionLengthMs(intervals);
    const completed =
      state.totalDurationMs > 0 && coveredMs * 10 >= state.totalDurationMs * 9;
    return { coveredMs, completed };
  }

  private getOrCreate(key: ObjectKey, totalDurationMs: number): ObjectState {
    const id = objectId(key);
    let state = this.objects.get(id);
    if (state === undefined) {
      state = { totalDurationMs, segments: new Map() };
      this.objects.set(id, state);
    } else if (state.totalDurationMs === 0 && totalDurationMs > 0) {
      state.totalDurationMs = totalDurationMs;
    }
    return state;
  }
}

export function createWatchCoverageService(): WatchCoverageService {
  return new WatchCoverageServiceImpl();
}
