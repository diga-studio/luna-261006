import { BusinessCalendar, LeadInspection } from "./types";
import { businessIntervals } from "./intervals";

export * from "./types";

export const SLA_BUDGET_MS = 4 * 3_600_000;

const CHUNK_MS = 7 * 24 * 3_600_000;

export function elapsed(calendar: BusinessCalendar, from: number, to: number): number {
  let total = 0;
  for (const iv of businessIntervals(calendar, from, to)) {
    total += iv.end - iv.start;
  }
  return total;
}

export function advance(calendar: BusinessCalendar, from: number, budgetMs: number): number {
  if (budgetMs <= 0) {
    return from;
  }
  let remaining = budgetMs;
  let cursor = from;
  for (;;) {
    const intervals = businessIntervals(calendar, cursor, cursor + CHUNK_MS);
    for (const iv of intervals) {
      const length = iv.end - iv.start;
      if (remaining <= length) {
        return iv.start + remaining;
      }
      remaining -= length;
    }
    cursor += CHUNK_MS;
  }
}

export function inspectLead(
  calendar: BusinessCalendar,
  createdAt: number,
  firstActionAt: number | null,
  asOf: number
): LeadInspection {
  const stop = firstActionAt !== null ? Math.min(firstActionAt, asOf) : asOf;
  const elapsedMs = elapsed(calendar, createdAt, stop);
  const followedUpInTime =
    firstActionAt !== null && elapsed(calendar, createdAt, firstActionAt) <= SLA_BUDGET_MS;
  return {
    elapsedMs,
    timedOut: !followedUpInTime && elapsedMs > SLA_BUDGET_MS,
  };
}
