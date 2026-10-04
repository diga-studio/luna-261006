import { test } from "node:test";
import { ok } from "node:assert/strict";
import { accumulateWorkMs, locateMilestones } from "../src/index.js";
import type { TimeInterval, WorkCalendar } from "../src/index.js";

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** 构造满足规模上限的日历：每周 14 段区间 + 2000 个例外日期。 */
function buildCalendar(): WorkCalendar {
  const weekly: TimeInterval[][] = [[], [], [], [], [], [], []];
  // 周一到周五每天 2 段，周六 4 段，共 14 段
  for (let d = 1; d <= 5; d++) {
    weekly[d] = [
      { startMinutes: 9 * 60, endMinutes: 12 * 60 },
      { startMinutes: 13 * 60, endMinutes: 18 * 60 },
    ];
  }
  weekly[6] = [
    { startMinutes: 8 * 60, endMinutes: 10 * 60 },
    { startMinutes: 10 * 60 + 30, endMinutes: 12 * 60 },
    { startMinutes: 14 * 60, endMinutes: 16 * 60 },
    { startMinutes: 22 * 60, endMinutes: 1 * 60 }, // 跨午夜
  ];
  const exceptions: Record<string, TimeInterval[]> = {};
  // 从 2026-01-01 起每隔 3 天一个例外，交替使用不同安排，凑满 2000 个
  const patterns: TimeInterval[][] = [
    [], // 假日
    [{ startMinutes: 20 * 60, endMinutes: 2 * 60 }], // 跨午夜夜班
    [
      { startMinutes: 0, endMinutes: 6 * 60 },
      { startMinutes: 12 * 60, endMinutes: 23 * 60 + 59 },
    ],
    [{ startMinutes: 10 * 60, endMinutes: 10 * 60 }], // 24 小时
  ];
  let date = Date.UTC(2026, 0, 1);
  for (let i = 0; i < 2000; i++) {
    const key = new Date(date).toISOString().slice(0, 10);
    exceptions[key] = patterns[i % patterns.length];
    date += 3 * DAY;
  }
  return { timeZone: "America/New_York", weekly, exceptions };
}

test("性能：跨 20 年的累计与定位均在 5 秒内完成", () => {
  const calendar = buildCalendar();
  const from = Date.UTC(2025, 0, 1);
  const to = Date.UTC(2045, 0, 1);

  const t0 = Date.now();
  const total = accumulateWorkMs(calendar, from, to);
  const t1 = Date.now();
  const accumulateMs = t1 - t0;
  ok(total > 0, "accumulated work should be positive");
  ok(accumulateMs < 5000, `accumulate over 20 years took ${accumulateMs}ms`);

  // 额度足够大，使到期时刻接近 20 年跨度的末尾
  const sla = total;
  const t2 = Date.now();
  const m = locateMilestones(calendar, from, sla, to);
  const t3 = Date.now();
  const locateMs = t3 - t2;
  ok(m.deadline !== null && m.deadline <= to, "deadline should be reachable");
  ok(locateMs < 5000, `locate over 20 years took ${locateMs}ms`);

  console.log(
    `perf: accumulate(20y)=${accumulateMs}ms locate(20y)=${locateMs}ms total=${total / HOUR}h`,
  );
});
