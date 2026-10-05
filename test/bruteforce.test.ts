import { describe, expect, it } from "vitest";
import {
  BoardScheduler,
  type CandidateSegment,
  type WeeklyWindow,
} from "../src/index.js";

/**
 * 独立核算（oracle）：对每个候选开始分钟 s，逐真实分钟检查
 * [s, s+时长) 内每个时刻是否落在该董事的某个周窗口内，
 * 整场都可用的受邀董事数 >= 法定人数时 s 合格。
 * 本地时间直接通过 Intl 逐个时刻换算，与实现走完全不同的路径。
 */

const MIN = 60_000;

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

const WEEKDAY: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** 返回 UTC 纪元分钟 t 在 tz 下的 (dayOfWeek, minuteOfDay)。 */
function localClock(tz: string, t: number): [number, number] {
  const parts = formatter(tz).formatToParts(t * MIN);
  let day = -1;
  let hour = 0;
  let minute = 0;
  for (const p of parts) {
    if (p.type === "weekday") day = WEEKDAY[p.value];
    else if (p.type === "hour") hour = Number(p.value) % 24;
    else if (p.type === "minute") minute = Number(p.value);
  }
  return [day, hour * 60 + minute];
}

function availableAt(windows: WeeklyWindow[], tz: string, t: number): boolean {
  const [day, mod] = localClock(tz, t);
  const pos = day * 1440 + mod;
  for (const w of windows) {
    const start = w.dayOfWeek * 1440 + w.startMinuteOfDay;
    const duration =
      w.endMinuteOfDay > w.startMinuteOfDay
        ? w.endMinuteOfDay - w.startMinuteOfDay
        : w.endMinuteOfDay + 1440 - w.startMinuteOfDay;
    const delta = (((pos - start) % 10080) + 10080) % 10080;
    if (delta < duration) return true;
  }
  return false;
}

interface OracleConfig {
  directors: { id: string; timeZone: string }[];
  windows: Map<string, WeeklyWindow[]>;
  invitedIds: string[];
  quorumPercent: number;
  rangeStart: number;
  rangeEnd: number;
  duration: number;
}

function oracleCandidates(cfg: OracleConfig): Set<number> {
  const quorum = Math.ceil((cfg.directors.length * cfg.quorumPercent) / 100);
  const width = cfg.rangeEnd - cfg.rangeStart;
  // 每位受邀董事在范围内每分钟的可用性 + 前缀和。
  const result = new Set<number>();
  const latestStart = cfg.rangeEnd - cfg.duration;
  const invited = cfg.invitedIds.filter((id) =>
    cfg.directors.some((d) => d.id === id),
  );
  const counts = new Int32Array(width);
  for (const id of invited) {
    const director = cfg.directors.find((d) => d.id === id)!;
    const windows = cfg.windows.get(id) ?? [];
    const prefix = new Int32Array(width + 1);
    for (let i = 0; i < width; i++) {
      const ok = availableAt(windows, director.timeZone, cfg.rangeStart + i);
      prefix[i + 1] = prefix[i] + (ok ? 1 : 0);
    }
    for (let s = 0; s <= latestStart - cfg.rangeStart; s++) {
      if (prefix[s + cfg.duration] - prefix[s] === cfg.duration) counts[s]++;
    }
  }
  for (let s = 0; s <= latestStart - cfg.rangeStart; s++) {
    if (counts[s] >= quorum) result.add(cfg.rangeStart + s);
  }
  return result;
}

function expand(segments: CandidateSegment[]): Set<number> {
  const out = new Set<number>();
  for (const seg of segments) {
    expect(seg.endUtcMinutes).toBeGreaterThanOrEqual(seg.startUtcMinutes);
    for (let m = seg.startUtcMinutes; m <= seg.endUtcMinutes; m++) {
      expect(out.has(m)).toBe(false); // 不得重复
      out.add(m);
    }
  }
  return out;
}

// 可复现的伪随机数。
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ZONES = [
  "UTC",
  "America/New_York",
  "America/Los_Angeles",
  "America/St_Johns",
  "Australia/Lord_Howe",
  "Australia/Sydney",
  "Europe/London",
  "Asia/Tokyo",
  "Asia/Kathmandu",
  "Pacific/Auckland",
];

// 覆盖多个 DST 切换日（含 Lord Howe 半小时切换）与随机日期。
const BASE_DATES = [
  "2024-03-10T00:00:00Z", // 纽约春拨
  "2024-11-03T00:00:00Z", // 纽约秋拨
  "2024-10-06T00:00:00Z", // Lord Howe 春拨（30 分钟）
  "2025-04-05T12:00:00Z", // Lord Howe 秋拨（30 分钟）
  "2024-03-31T00:00:00Z", // 欧洲春拨
  "2024-10-27T00:00:00Z", // 欧洲秋拨
  "2020-06-15T00:00:00Z",
  "2027-01-20T00:00:00Z",
  "2031-07-04T00:00:00Z",
  "2035-12-31T00:00:00Z",
];

function randomConfig(rand: () => number, index: number): OracleConfig {
  const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];
  const directorCount = 1 + Math.floor(rand() * 4);
  const directors = Array.from({ length: directorCount }, (_, i) => ({
    id: `d${i}`,
    timeZone: pick(ZONES),
  }));
  const windows = new Map<string, WeeklyWindow[]>();
  for (const d of directors) {
    const n = Math.floor(rand() * 4); // 0..3 段
    const ws: WeeklyWindow[] = [];
    for (let i = 0; i < n; i++) {
      const startMinuteOfDay = Math.floor(rand() * 1440);
      let endMinuteOfDay = Math.floor(rand() * 1440);
      if (endMinuteOfDay === startMinuteOfDay) {
        endMinuteOfDay = (endMinuteOfDay + 1) % 1440;
      }
      ws.push({
        dayOfWeek: Math.floor(rand() * 7),
        startMinuteOfDay,
        endMinuteOfDay,
      });
    }
    windows.set(d.id, ws);
  }
  const invitedIds = directors
    .map((d) => d.id)
    .filter(() => rand() < 0.8);
  if (invitedIds.length === 0) invitedIds.push(directors[0].id);
  const base = Date.parse(BASE_DATES[index % BASE_DATES.length]) / MIN;
  const rangeStart = base + Math.floor(rand() * 720);
  const span = 720 + Math.floor(rand() * 2160); // 12 小时 .. 3 天
  return {
    directors,
    windows,
    invitedIds,
    quorumPercent: pick([1, 30, 50, 60, 67, 80, 100]),
    rangeStart,
    rangeEnd: rangeStart + span,
    duration: 15 + Math.floor(rand() * 225), // 15..239 分钟
  };
}

describe("与逐分钟独立核算对照", () => {
  for (let i = 0; i < 40; i++) {
    it(`随机用例 #${i}`, () => {
      const cfg = randomConfig(mulberry32(0x5eed + i * 7919), i);
      const scheduler = new BoardScheduler();
      scheduler.setDirectors(cfg.directors);
      for (const d of cfg.directors) {
        scheduler.setWeeklyAvailability(d.id, cfg.windows.get(d.id) ?? []);
      }
      const segments = scheduler.findCandidates({
        invitedIds: cfg.invitedIds,
        quorumPercent: cfg.quorumPercent,
        rangeStartUtcMinutes: cfg.rangeStart,
        rangeEndUtcMinutes: cfg.rangeEnd,
        durationMinutes: cfg.duration,
      });
      const expected = oracleCandidates(cfg);
      const actual = expand(segments);
      const iso = (m: number) => new Date(m * MIN).toISOString();
      const missing = [...expected].filter((m) => !actual.has(m)).map(iso);
      const extra = [...actual].filter((m) => !expected.has(m)).map(iso);
      expect(
        { missing: missing.slice(0, 5), extra: extra.slice(0, 5) },
        `缺失 ${missing.length} 个、多出 ${extra.length} 个`,
      ).toEqual({ missing: [], extra: [] });
    });
  }
});
