import { workSegmentsBetween } from "./segments.js";
import type { Milestones, WorkCalendar } from "./types.js";

/** 计算 [fromUtcMs, toUtcMs) 之间累计的工作时长（毫秒）。 */
export function accumulateWorkMs(
  calendar: WorkCalendar,
  fromUtcMs: number,
  toUtcMs: number,
): number {
  if (toUtcMs <= fromUtcMs) return 0;
  let total = 0;
  for (const seg of workSegmentsBetween(calendar, fromUtcMs, toUtcMs)) {
    total += seg.end - seg.start;
  }
  return total;
}

/**
 * 从 startUtcMs 起累计工作时长，定位 50% / 80% / 100% 里程碑。
 * 提醒额度为总额度乘比例后向上取整到毫秒；
 * 各里程碑取累计工作时长首次达到对应额度的 UTC 时刻；
 * 到 maxUtcMs（含）仍不足额度的记为不可达（null）。
 */
export function locateMilestones(
  calendar: WorkCalendar,
  startUtcMs: number,
  slaMs: number,
  maxUtcMs: number,
): Milestones {
  if (!Number.isInteger(slaMs) || slaMs <= 0) {
    throw new RangeError("slaMs must be a positive integer number of milliseconds");
  }
  const targets: Array<{ key: keyof Milestones; quota: number; hit: number | null }> = [
    { key: "remind50", quota: Math.ceil(slaMs * 0.5), hit: null },
    { key: "remind80", quota: Math.ceil(slaMs * 0.8), hit: null },
    { key: "deadline", quota: slaMs, hit: null },
  ];
  let accumulated = 0;
  let pending = targets.slice();
  if (maxUtcMs >= startUtcMs) {
    for (const seg of workSegmentsBetween(calendar, startUtcMs, maxUtcMs)) {
      let cursor = seg.start;
      while (pending.length > 0) {
        const next = pending[0];
        const remaining = next.quota - accumulated;
        if (cursor + remaining <= seg.end) {
          next.hit = cursor + remaining;
          accumulated = next.quota;
          cursor = next.hit;
          pending.shift();
        } else {
          accumulated += seg.end - cursor;
          cursor = seg.end;
          break;
        }
      }
      if (pending.length === 0) break;
    }
  }
  const result: Milestones = { remind50: null, remind80: null, deadline: null };
  for (const t of targets) result[t.key] = t.hit;
  return result;
}
