import { workIntervalsUtc } from "./intervals.js";
import type { SlaMilestones, WorkCalendar } from "./types.js";

/** 计算 [fromMs, toMs) 内累计的工作毫秒数。 */
export function computeWorkMs(
  calendar: WorkCalendar,
  fromMs: number,
  toMs: number,
): number {
  if (!(fromMs < toMs)) return 0;
  let total = 0;
  for (const [a, b] of workIntervalsUtc(calendar, fromMs, toMs)) {
    total += b - a;
  }
  return total;
}

/**
 * 从 startMs 起，定位累计工作时长首次达到总额度 50% / 80% / 100% 的 UTC 时刻。
 * 额度按 50% / 80% / 100% 向上取整到毫秒；到 latestMs（含）仍达不到的里程碑 at 为 null。
 */
export function locateMilestones(
  calendar: WorkCalendar,
  startMs: number,
  slaMs: number,
  latestMs: number,
): SlaMilestones {
  if (!Number.isInteger(slaMs) || slaMs <= 0) {
    throw new RangeError(`slaMs must be a positive integer, got ${slaMs}`);
  }
  // 用整数运算避免 0.8 等二进制浮点误差（如 5 * 0.8 > 4）
  const quotas: Array<{ key: keyof SlaMilestones; quotaMs: number }> = [
    { key: "remind50", quotaMs: Math.ceil(slaMs / 2) },
    { key: "remind80", quotaMs: Math.ceil((slaMs * 4) / 5) },
    { key: "deadline", quotaMs: slaMs },
  ];
  const result: SlaMilestones = {
    remind50: { quotaMs: quotas[0].quotaMs, at: null },
    remind80: { quotaMs: quotas[1].quotaMs, at: null },
    deadline: { quotaMs: quotas[2].quotaMs, at: null },
  };
  if (!(startMs <= latestMs)) return result;

  let accumulated = 0;
  let quotaIdx = 0;
  // 工作区间为左闭右开，[startMs, latestMs] 的右端点若恰为区间右边界，
  // 累计在 latestMs 处足额，里程碑取 latestMs（边界保留，不顺延）。
  for (const [a, b] of workIntervalsUtc(calendar, startMs, latestMs)) {
    while (quotaIdx < quotas.length && accumulated + (b - a) >= quotas[quotaIdx].quotaMs) {
      const at = a + (quotas[quotaIdx].quotaMs - accumulated);
      if (at > latestMs) return result;
      result[quotas[quotaIdx].key].at = at;
      quotaIdx++;
    }
    if (quotaIdx >= quotas.length) return result;
    accumulated += b - a;
  }
  return result;
}
