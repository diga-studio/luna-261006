import { describe, expect, it } from "vitest";
import { BoardScheduler, type WeeklyWindow } from "../src/index.js";

const MIN = 60_000;

const ZONES_20 = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/St_Johns",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Helsinki",
  "Europe/Moscow",
  "Asia/Dubai",
  "Asia/Kathmandu",
  "Asia/Kolkata",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Australia/Lord_Howe",
  "Pacific/Auckland",
  "Pacific/Chatham",
];

describe("规定规模性能", () => {
  it(
    "300 董事 × 10 窗口 × 20 时区 × 180 天跨度，单次查询 < 20 秒",
    { timeout: 60_000 },
    () => {
      const scheduler = new BoardScheduler();
      const directors = Array.from({ length: 300 }, (_, i) => ({
        id: `d${i}`,
        timeZone: ZONES_20[i % ZONES_20.length],
      }));
      scheduler.setDirectors(directors);
      for (let i = 0; i < directors.length; i++) {
        const windows: WeeklyWindow[] = Array.from(
          { length: 10 },
          (_, j) => {
            const start = (i * 37 + j * 141) % 1440;
            const span = 30 + ((i * 13 + j * 29) % 600);
            return {
              dayOfWeek: (i + j) % 7,
              startMinuteOfDay: start,
              endMinuteOfDay: (start + span) % 1440 === start
                ? (start + 1) % 1440
                : (start + span) % 1440,
            };
          },
        );
        scheduler.setWeeklyAvailability(directors[i].id, windows);
      }
      const rangeStart = Date.parse("2026-01-01T00:00:00Z") / MIN;
      const rangeEnd = rangeStart + 180 * 24 * 60;
      const t0 = performance.now();
      const result = scheduler.findCandidates({
        invitedIds: directors.map((d) => d.id),
        quorumPercent: 60,
        rangeStartUtcMinutes: rangeStart,
        rangeEndUtcMinutes: rangeEnd,
        durationMinutes: 60,
      });
      const elapsedMs = performance.now() - t0;
      console.log(`查询耗时 ${elapsedMs.toFixed(0)}ms，候选段 ${result.length} 个`);
      expect(elapsedMs).toBeLessThan(20_000);
      // 结果必须是合法的最大连续段：相邻段之间至少隔一个不合格分钟。
      for (let i = 1; i < result.length; i++) {
        expect(result[i].startUtcMinutes).toBeGreaterThan(
          result[i - 1].endUtcMinutes + 1,
        );
      }
    },
  );
});
