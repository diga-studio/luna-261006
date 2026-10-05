import assert from "node:assert/strict";
import test from "node:test";
import { BoardScheduler } from "../src/index.js";
import type { CandidateInterval, WeeklyWindow } from "../src/index.js";

const MIN = 60_000;
const DAY_MIN = 24 * 60;
const WEEK_MIN = 7 * DAY_MIN;

/** Independent per-minute reference implementation (Intl-only). */
const refFormatters = new Map<string, Intl.DateTimeFormat>();
function refFormatter(tz: string): Intl.DateTimeFormat {
  let fmt = refFormatters.get(tz);
  if (fmt === undefined) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
    refFormatters.set(tz, fmt);
  }
  return fmt;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

function refLocalWeekMinute(tz: string, utcMs: number): number {
  const parts = refFormatter(tz).formatToParts(new Date(utcMs));
  let weekday = -1;
  let hour = -1;
  let minute = -1;
  for (const part of parts) {
    if (part.type === "weekday") weekday = WEEKDAY_INDEX[part.value]!;
    else if (part.type === "hour") hour = Number(part.value);
    else if (part.type === "minute") minute = Number(part.value);
  }
  return weekday * DAY_MIN + hour * 60 + minute;
}

function refAvailableAt(windows: readonly WeeklyWindow[], weekMinute: number): boolean {
  for (const win of windows) {
    const start = win.startDay * DAY_MIN + win.startMinute;
    const duration = (win.endMinute - win.startMinute + DAY_MIN) % DAY_MIN;
    const offset = ((weekMinute - start) % WEEK_MIN + WEEK_MIN) % WEEK_MIN;
    if (offset < duration) return true;
  }
  return false;
}

interface RefDirector {
  readonly timeZone: string;
  readonly windows: readonly WeeklyWindow[];
}

/** Full set of qualifying start minutes, computed minute by minute. */
function refCandidates(
  rosterSize: number,
  invitees: readonly RefDirector[],
  quorumPercent: number,
  rangeStartMs: number,
  rangeEndMs: number,
  durationMinutes: number,
): number[] {
  const quorum = Math.ceil((rosterSize * quorumPercent) / 100);
  const result: number[] = [];
  const lastStart = rangeEndMs - durationMinutes * MIN;
  for (let t = rangeStartMs; t <= lastStart; t += MIN) {
    let count = 0;
    for (const director of invitees) {
      let ok = true;
      for (let m = t; m < t + durationMinutes * MIN; m += MIN) {
        if (!refAvailableAt(director.windows, refLocalWeekMinute(director.timeZone, m))) {
          ok = false;
          break;
        }
      }
      if (ok) count += 1;
    }
    if (count >= quorum) result.push(t);
  }
  return result;
}

function expand(intervals: readonly CandidateInterval[]): number[] {
  const out: number[] = [];
  for (const iv of intervals) {
    for (let ms = iv.firstStartMs; ms <= iv.lastStartMs; ms += MIN) out.push(ms);
  }
  return out;
}

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TIMEZONES = [
  "UTC",
  "America/New_York",
  "America/Santiago",
  "America/St_Johns",
  "Europe/London",
  "Europe/Berlin",
  "Africa/Casablanca",
  "Asia/Shanghai",
  "Asia/Kathmandu",
  "Australia/Sydney",
  "Australia/Lord_Howe",
  "Pacific/Auckland",
  "Pacific/Chatham",
  "America/Los_Angeles",
  "Asia/Tehran",
];

test("random small cases match the independent per-minute reference", () => {
  const random = rng(20261006);
  const pick = <T,>(items: readonly T[]): T =>
    items[Math.floor(random() * items.length)]!;
  const cases = 60;
  for (let caseNo = 0; caseNo < cases; caseNo += 1) {
    const rosterSize = 1 + Math.floor(random() * 5);
    const scheduler = new BoardScheduler();
    const roster = Array.from({ length: rosterSize }, (_, i) => ({
      id: `D${i}`,
      timeZone: pick(TIMEZONES),
    }));
    scheduler.setRoster(roster);
    const refDirectors = new Map<string, RefDirector>();
    for (const director of roster) {
      const windowCount = Math.floor(random() * 4);
      const windows: WeeklyWindow[] = [];
      for (let w = 0; w < windowCount; w += 1) {
        const startMinute = Math.floor(random() * DAY_MIN);
        let endMinute = Math.floor(random() * DAY_MIN);
        if (endMinute === startMinute) endMinute = (endMinute + 1) % DAY_MIN;
        windows.push({
          startDay: Math.floor(random() * 7) as WeeklyWindow["startDay"],
          startMinute,
          endMinute,
        });
      }
      scheduler.setWeeklyAvailability(director.id, windows);
      refDirectors.set(director.id, {
        timeZone: director.timeZone,
        windows,
      });
    }
    // Random 2-6 day range somewhere in 2020-2035.
    const minMs = Date.parse("2020-01-01T00:00:00Z");
    const maxMs = Date.parse("2035-12-20T00:00:00Z");
    const rangeStartMs =
      minMs + Math.floor(random() * ((maxMs - minMs) / MIN)) * MIN;
    const spanDays = 2 + Math.floor(random() * 5);
    const rangeEndMs = rangeStartMs + spanDays * DAY_MIN * MIN;
    const durationMinutes = 30 + Math.floor(random() * 8) * 30;
    const quorumPercent = pick([40, 50, 60, 67, 75, 100]);
    const invitees = roster.filter(() => random() < 0.8);
    const inviteeIds = invitees.map((d) => d.id);

    const expected = refCandidates(
      rosterSize,
      invitees.map((d) => refDirectors.get(d.id)!),
      quorumPercent,
      rangeStartMs,
      rangeEndMs,
      durationMinutes,
    );
    const actual = scheduler.findCandidates({
      rangeStartMs,
      rangeEndMs,
      durationMinutes,
      quorumPercent,
      inviteeIds,
    });
    const actualMinutes = expand(actual);
    assert.deepEqual(
      actualMinutes,
      expected,
      `case ${caseNo}: candidate sets differ`,
    );
    // Compression sanity: intervals are sorted, non-empty, and disjoint
    // with gaps (no two runs touch).
    for (let i = 0; i < actual.length; i += 1) {
      const iv = actual[i]!;
      assert.ok(iv.lastStartMs >= iv.firstStartMs, "non-empty run");
      if (i > 0) {
        assert.ok(
          iv.firstStartMs > actual[i - 1]!.lastStartMs + MIN,
          "runs are maximal and disjoint",
        );
      }
    }
  }
});
