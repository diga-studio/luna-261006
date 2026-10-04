import { test } from "node:test";
import assert from "node:assert/strict";
import { computeWorkMs, locateMilestones } from "../src/index.js";
import type { WorkCalendar, WeeklySchedule, WorkInterval } from "../src/index.js";

const MIN = 60_000;
const HOUR = 3_600_000;

function emptyWeek(): WeeklySchedule {
  return [[], [], [], [], [], [], []];
}

function iv(startMinute: number, endMinute: number): WorkInterval {
  return { startMinute, endMinute };
}

// 2025-06-02 是周一，2025-06-03 是周二（UTC）
test("跨午夜区间进入空安排假日：尾段仍计时", () => {
  const weekly = emptyWeek();
  weekly[1] = [iv(22 * 60, 2 * 60)]; // 周一 22:00 - 次日 02:00
  const cal: WorkCalendar = {
    timeZone: "UTC",
    weekly,
    exceptions: [{ date: "2025-06-03", intervals: [] }], // 周二假日
  };
  const from = Date.parse("2025-06-02T21:00:00Z");
  const to = Date.parse("2025-06-03T03:00:00Z");
  assert.equal(computeWorkMs(cal, from, to), 4 * HOUR); // 22:00-02:00 全计，假日不截断
});

test("重叠区间不重复计时", () => {
  const weekly = emptyWeek();
  weekly[1] = [iv(22 * 60, 2 * 60), iv(23 * 60, 1 * 60)]; // 22-02 与 23-01 重叠
  const cal: WorkCalendar = { timeZone: "UTC", weekly };
  const from = Date.parse("2025-06-02T21:00:00Z");
  const to = Date.parse("2025-06-03T03:00:00Z");
  assert.equal(computeWorkMs(cal, from, to), 4 * HOUR); // 并集 22:00-02:00
});

test("日期例外完全替换每周安排", () => {
  const weekly = emptyWeek();
  weekly[2] = [iv(9 * 60, 17 * 60)]; // 周二 9-17
  const cal: WorkCalendar = {
    timeZone: "UTC",
    weekly,
    exceptions: [{ date: "2025-06-03", intervals: [iv(20 * 60, 21 * 60)] }],
  };
  const from = Date.parse("2025-06-03T00:00:00Z");
  const to = Date.parse("2025-06-04T00:00:00Z");
  assert.equal(computeWorkMs(cal, from, to), 1 * HOUR); // 只有例外的 20:00-21:00
});

test("开始时刻落在休息时间：休息部分不消耗额度", () => {
  const weekly = emptyWeek();
  weekly[1] = [iv(9 * 60, 17 * 60)];
  const cal: WorkCalendar = { timeZone: "UTC", weekly };
  const start = Date.parse("2025-06-01T12:00:00Z"); // 周日，无安排
  const m = locateMilestones(cal, start, 2 * HOUR, Date.parse("2025-06-03T00:00:00Z"));
  assert.equal(m.remind50.at, Date.parse("2025-06-02T10:00:00Z"));
  assert.equal(m.deadline.at, Date.parse("2025-06-02T11:00:00Z"));
});

test("查找范围不足：部分里程碑不可达，边界恰好耗尽保留", () => {
  const weekly = emptyWeek();
  weekly[1] = [iv(22 * 60, 2 * 60)]; // 周一 22:00 - 周二 02:00
  const cal: WorkCalendar = { timeZone: "UTC", weekly };
  const start = Date.parse("2025-06-02T22:30:00Z");
  const latest = Date.parse("2025-06-03T00:30:00Z"); // 范围内只有 2 小时工作
  const m = locateMilestones(cal, start, 4 * HOUR, latest);
  assert.equal(m.remind50.at, latest); // 2h 恰好在 latestMs 耗尽，边界保留
  assert.equal(m.remind80.at, null);
  assert.equal(m.deadline.at, null);
});

test("额度恰好在下班边界耗尽：取该边界，不顺延", () => {
  const weekly = emptyWeek();
  weekly[1] = [iv(22 * 60, 2 * 60)];
  const cal: WorkCalendar = { timeZone: "UTC", weekly };
  const start = Date.parse("2025-06-02T22:00:00Z");
  const m = locateMilestones(cal, start, 4 * HOUR, Date.parse("2025-06-03T02:00:00Z"));
  assert.equal(m.deadline.at, Date.parse("2025-06-03T02:00:00Z")); // 下班边界
  // latestMs 恰好等于边界也可达
  const m2 = locateMilestones(cal, start, 4 * HOUR, Date.parse("2025-06-03T02:00:00Z"));
  assert.equal(m2.remind80.at, Date.parse("2025-06-03T01:12:00Z")); // 3.2h
});

test("startMinute == endMinute 表示 24 小时区间", () => {
  const weekly = emptyWeek();
  weekly[3] = [iv(10 * 60, 10 * 60)]; // 周三 10:00 到次日 10:00
  const cal: WorkCalendar = { timeZone: "UTC", weekly };
  const from = Date.parse("2025-06-04T00:00:00Z"); // 周三
  const to = Date.parse("2025-06-05T12:00:00Z");
  assert.equal(computeWorkMs(cal, from, to), 24 * HOUR);
});

test("额度取整：奇数毫秒额度向上取整", () => {
  const weekly = emptyWeek();
  weekly[1] = [iv(0, 0)]; // 周一全天
  const cal: WorkCalendar = { timeZone: "UTC", weekly };
  const start = Date.parse("2025-06-02T00:00:00Z");
  const m = locateMilestones(cal, start, 5, Date.parse("2025-06-03T00:00:00Z"));
  assert.equal(m.remind50.quotaMs, 3); // ceil(2.5)
  assert.equal(m.remind80.quotaMs, 4); // ceil(4.0)，不受 0.8 浮点误差影响
  assert.equal(m.remind50.at, start + 3);
  assert.equal(m.remind80.at, start + 4);
  assert.equal(m.deadline.at, start + 5);
});

test("多个里程碑可以相同", () => {
  const weekly = emptyWeek();
  weekly[1] = [iv(9 * 60, 17 * 60)];
  const cal: WorkCalendar = { timeZone: "UTC", weekly };
  // 从 16:00 开始，1 小时额度：50%/80%/100% 都在 17:00 边界前
  const start = Date.parse("2025-06-02T16:00:00Z");
  const m = locateMilestones(cal, start, HOUR, Date.parse("2025-06-03T00:00:00Z"));
  assert.equal(m.remind50.at, Date.parse("2025-06-02T16:30:00Z"));
  assert.equal(m.remind80.at, Date.parse("2025-06-02T16:48:00Z"));
  assert.equal(m.deadline.at, Date.parse("2025-06-02T17:00:00Z"));
});
