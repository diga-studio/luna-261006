import { test } from "node:test";
import assert from "node:assert/strict";
import { computeWorkMs, locateMilestones } from "../src/index.js";
import type { ExceptionDay, WorkCalendar, WeeklySchedule } from "../src/index.js";

const DAY_MS = 86_400_000;
const HOUR = 3_600_000;

/** 每周 14 段（每天 2 段）、2000 个例外日期、跨 20 年的日历 */
function bigCalendar(): { cal: WorkCalendar; fromMs: number; toMs: number } {
  const weekly = [] as unknown as WeeklySchedule;
  for (let d = 0; d < 7; d++) {
    weekly[d] = [
      { startMinute: 9 * 60, endMinute: 12 * 60 },
      { startMinute: 13 * 60, endMinute: 18 * 60 },
    ];
  }
  const fromMs = Date.parse("2025-01-01T00:00:00Z");
  const toMs = Date.parse("2045-01-01T00:00:00Z");
  const exceptions: ExceptionDay[] = [];
  for (let i = 0; i < 2000; i++) {
    const dayMs = fromMs + (i * 3 + 1) * DAY_MS; // 每隔 3 天一个例外，覆盖约 16 年
    const date = new Date(dayMs).toISOString().slice(0, 10);
    exceptions.push({
      date,
      intervals:
        i % 5 === 0
          ? [] // 假日
          : [
              { startMinute: 8 * 60 + (i % 60), endMinute: 11 * 60 },
              { startMinute: 22 * 60, endMinute: 1 * 60 }, // 跨午夜
            ],
    });
  }
  return { cal: { timeZone: "America/New_York", weekly, exceptions }, fromMs, toMs };
}

test("20 年跨度：累计与定位均在 5 秒内，且结果相互吻合", () => {
  const { cal, fromMs, toMs } = bigCalendar();

  const t0 = performance.now();
  const total = computeWorkMs(cal, fromMs, toMs);
  const t1 = performance.now();
  assert.ok(total > 0, "20 年应有工作时长");
  assert.ok(t1 - t0 < 5000, `累计耗时 ${(t1 - t0).toFixed(0)}ms 超过 5 秒`);

  const t2 = performance.now();
  const m = locateMilestones(cal, fromMs, total, toMs);
  const t3 = performance.now();
  assert.ok(t3 - t2 < 5000, `定位耗时 ${(t3 - t2).toFixed(0)}ms 超过 5 秒`);

  // 额度 = 20 年全部工作时长，到期时刻应可达且不晚于 toMs
  assert.ok(m.deadline.at !== null && m.deadline.at <= toMs);
  // 累计与定位吻合：到各里程碑时刻的累计恰好等于对应额度
  assert.equal(computeWorkMs(cal, fromMs, m.remind50.at!), m.remind50.quotaMs);
  assert.equal(computeWorkMs(cal, fromMs, m.remind80.at!), m.remind80.quotaMs);
  assert.equal(computeWorkMs(cal, fromMs, m.deadline.at!), m.deadline.quotaMs);
  // 里程碑单调
  assert.ok(m.remind50.at! <= m.remind80.at! && m.remind80.at! <= m.deadline.at!);

  console.log(
    `  [perf] accumulate(20y)=${(t1 - t0).toFixed(1)}ms locate(20y)=${(t3 - t2).toFixed(1)}ms totalWork=${(total / HOUR).toFixed(0)}h`,
  );
});

test("结果不依赖机器默认时区", () => {
  const { cal, fromMs } = bigCalendar();
  const toMs = fromMs + 30 * DAY_MS;
  const before = computeWorkMs(cal, fromMs, toMs);
  const oldTz = process.env.TZ;
  try {
    process.env.TZ = "Pacific/Kiritimati"; // UTC+14，与日历时区差异最大
    const after = computeWorkMs(cal, fromMs, toMs);
    assert.equal(after, before);
  } finally {
    if (oldTz === undefined) delete process.env.TZ;
    else process.env.TZ = oldTz;
  }
});
