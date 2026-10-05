import { computeAvailableIntervals } from "./availability.js";
import { offsetMinutesAt, offsetSegments, type OffsetSegment } from "./tz.js";
import type {
  CandidateSegment,
  Director,
  FindCandidatesQuery,
  WeeklyWindow,
} from "./types.js";

const DEFAULT_QUORUM_PERCENT = 60;

function assertInteger(value: number, name: string): void {
  if (!Number.isInteger(value)) {
    throw new RangeError(`${name} 必须是整数，收到: ${value}`);
  }
}

function validateWindow(window: WeeklyWindow): void {
  assertInteger(window.dayOfWeek, "dayOfWeek");
  if (window.dayOfWeek < 0 || window.dayOfWeek > 6) {
    throw new RangeError(`dayOfWeek 必须在 0..6，收到: ${window.dayOfWeek}`);
  }
  assertInteger(window.startMinuteOfDay, "startMinuteOfDay");
  assertInteger(window.endMinuteOfDay, "endMinuteOfDay");
  for (const [name, v] of [
    ["startMinuteOfDay", window.startMinuteOfDay],
    ["endMinuteOfDay", window.endMinuteOfDay],
  ] as const) {
    if (v < 0 || v > 1439) {
      throw new RangeError(`${name} 必须在 0..1439，收到: ${v}`);
    }
  }
  if (window.startMinuteOfDay === window.endMinuteOfDay) {
    throw new RangeError("窗口起止时分不得相同");
  }
}

/**
 * 董事会议候选时段库。全部状态存于进程内存：
 * 在任名册、每名董事的周可用窗口。调用方串行调用，
 * 配置只在两次查询之间修改。
 */
export class BoardScheduler {
  private readonly directors = new Map<string, Director>();
  private readonly availability = new Map<string, WeeklyWindow[]>();

  /** 整体替换在任名册。 */
  setDirectors(directors: Director[]): void {
    const next = new Map<string, Director>();
    for (const director of directors) {
      if (!director || typeof director.id !== "string" || director.id.length === 0) {
        throw new TypeError("董事 id 必须是非空字符串");
      }
      if (next.has(director.id)) {
        throw new Error(`董事 id 重复: ${director.id}`);
      }
      // 借一次偏移计算校验 IANA 时区名，非法时立即抛错。
      offsetMinutesAt(director.timeZone, 0);
      next.set(director.id, { id: director.id, timeZone: director.timeZone });
    }
    this.directors.clear();
    for (const [id, director] of next) this.directors.set(id, director);
    for (const id of [...this.availability.keys()]) {
      if (!this.directors.has(id)) this.availability.delete(id);
    }
  }

  /** 替换一名在任董事的周可用窗口（空数组表示无可用时间）。 */
  setWeeklyAvailability(directorId: string, windows: WeeklyWindow[]): void {
    if (!this.directors.has(directorId)) {
      throw new Error(`董事不在在任名册中: ${directorId}`);
    }
    for (const window of windows) validateWindow(window);
    this.availability.set(
      directorId,
      windows.map((w) => ({ ...w })),
    );
  }

  /**
   * 查询候选时段：返回全部合格开始分钟，压缩为最大连续区间，
   * 每段首尾均为合格开始分钟；无候选时返回空数组。
   */
  findCandidates(query: FindCandidatesQuery): CandidateSegment[] {
    const {
      invitedIds,
      quorumPercent = DEFAULT_QUORUM_PERCENT,
      rangeStartUtcMinutes: rangeStart,
      rangeEndUtcMinutes: rangeEnd,
      durationMinutes: duration,
    } = query;

    assertInteger(rangeStart, "rangeStartUtcMinutes");
    assertInteger(rangeEnd, "rangeEndUtcMinutes");
    assertInteger(duration, "durationMinutes");
    assertInteger(quorumPercent, "quorumPercent");
    if (rangeEnd <= rangeStart) {
      throw new RangeError("搜索范围终点必须大于起点");
    }
    if (duration <= 0) {
      throw new RangeError("会议时长必须是正整数分钟");
    }
    if (quorumPercent < 1 || quorumPercent > 100) {
      throw new RangeError(`quorumPercent 必须在 1..100，收到: ${quorumPercent}`);
    }
    for (const id of invitedIds) {
      if (!this.directors.has(id)) {
        throw new Error(`受邀董事不在在任名册中: ${id}`);
      }
    }

    const quorum = Math.ceil((this.directors.size * quorumPercent) / 100);
    const latestStart = rangeEnd - duration; // 合格开始分钟的上界（含）
    if (latestStart < rangeStart || invitedIds.length < quorum) {
      return [];
    }

    // 同一时区的偏移分段在一次查询内复用。
    const segmentsByZone = new Map<string, OffsetSegment[]>();
    const zoneSegments = (timeZone: string): OffsetSegment[] => {
      let segs = segmentsByZone.get(timeZone);
      if (!segs) {
        segs = offsetSegments(timeZone, rangeStart, rangeEnd);
        segmentsByZone.set(timeZone, segs);
      }
      return segs;
    };

    // 差分数组统计每个开始分钟上"整场都可用"的受邀董事数。
    const width = rangeEnd - rangeStart;
    const diff = new Int32Array(width + 2);
    const seen = new Set<string>();
    for (const id of invitedIds) {
      if (seen.has(id)) continue; // 同一董事只计一次
      seen.add(id);
      const director = this.directors.get(id)!;
      const windows = this.availability.get(id);
      if (!windows || windows.length === 0) continue;
      const intervals = computeAvailableIntervals(
        windows,
        zoneSegments(director.timeZone),
        rangeStart,
        rangeEnd,
      );
      for (const interval of intervals) {
        // 会议 [s, s+duration) 完整落在该可用区间内 <=> s ∈ [a, b-duration]。
        const goodStart = Math.max(interval.startUtcMinutes, rangeStart);
        const goodEnd = Math.min(interval.endUtcMinutes - duration, latestStart);
        if (goodStart <= goodEnd) {
          diff[goodStart - rangeStart] += 1;
          diff[goodEnd - rangeStart + 1] -= 1;
        }
      }
    }

    const segments: CandidateSegment[] = [];
    let count = 0;
    let segStart = -1;
    for (let i = 0; i <= latestStart - rangeStart; i++) {
      count += diff[i];
      const qualified = count >= quorum;
      if (qualified && segStart < 0) {
        segStart = i;
      } else if (!qualified && segStart >= 0) {
        segments.push({
          startUtcMinutes: rangeStart + segStart,
          endUtcMinutes: rangeStart + i - 1,
        });
        segStart = -1;
      }
    }
    if (segStart >= 0) {
      segments.push({
        startUtcMinutes: rangeStart + segStart,
        endUtcMinutes: latestStart,
      });
    }
    return segments;
  }
}
