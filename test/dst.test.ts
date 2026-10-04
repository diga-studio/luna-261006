import { test } from "node:test";
import assert from "node:assert/strict";
import { computeWorkMs, locateMilestones } from "../src/index.js";
import type { WorkCalendar, WeeklySchedule } from "../src/index.js";

const MIN = 60_000;

function emptyWeek(): WeeklySchedule {
  return [[], [], [], [], [], [], []];
}

/** 仅指定日期有安排的日历（其余时间均为非工作） */
function onlyOn(timeZone: string, date: string, intervals: Array<[number, number]>): WorkCalendar {
  return {
    timeZone,
    weekly: emptyWeek(),
    exceptions: [
      { date, intervals: intervals.map(([s, e]) => ({ startMinute: s, endMinute: e })) },
    ],
  };
}

test("America/New_York 2025-11-02 回拨日：01:15-01:45 计 60 分钟", () => {
  const cal = onlyOn("America/New_York", "2025-11-02", [[75, 105]]);
  // 当地 2025-11-02 全天 = UTC 04:00 ~ 次日 05:00
  const from = Date.parse("2025-11-02T04:00:00Z");
  const to = Date.parse("2025-11-03T05:00:00Z");
  assert.equal(computeWorkMs(cal, from, to), 60 * MIN);
});

test("America/New_York 2025-11-02：30 分钟额度的三个里程碑", () => {
  const cal = onlyOn("America/New_York", "2025-11-02", [[75, 105]]);
  const start = Date.parse("2025-11-02T05:30:00Z");
  const sla = 30 * MIN;
  const latest = Date.parse("2025-11-03T00:00:00Z");
  const m = locateMilestones(cal, start, sla, latest);
  assert.equal(m.remind50.at, Date.parse("2025-11-02T05:45:00Z"));
  assert.equal(m.remind80.at, Date.parse("2025-11-02T06:24:00Z"));
  assert.equal(m.deadline.at, Date.parse("2025-11-02T06:30:00Z"));
  // 累计与定位相互吻合
  assert.equal(computeWorkMs(cal, start, m.remind50.at!), m.remind50.quotaMs);
  assert.equal(computeWorkMs(cal, start, m.remind80.at!), m.remind80.quotaMs);
  assert.equal(computeWorkMs(cal, start, m.deadline.at!), m.deadline.quotaMs);
});

test("America/New_York 2025-03-09 春进日：02:15-03:15 只计 15 分钟", () => {
  const cal = onlyOn("America/New_York", "2025-03-09", [[135, 195]]);
  const from = Date.parse("2025-03-09T05:00:00Z");
  const to = Date.parse("2025-03-10T04:00:00Z");
  assert.equal(computeWorkMs(cal, from, to), 15 * MIN);
});

test("Australia/Lord_Howe 2025-04-06 回拨 30 分钟：01:40-01:50 计 20 分钟", () => {
  const cal = onlyOn("Australia/Lord_Howe", "2025-04-06", [[100, 110]]);
  const from = Date.parse("2025-04-05T13:00:00Z");
  const to = Date.parse("2025-04-06T13:00:00Z");
  assert.equal(computeWorkMs(cal, from, to), 20 * MIN);
});

test("Australia/Lord_Howe 非整小时偏移：定位结果精确到毫秒", () => {
  const cal = onlyOn("Australia/Lord_Howe", "2025-04-06", [[100, 110]]);
  const start = Date.parse("2025-04-05T15:09:30.500Z"); // 当地 01:39:30.500（回拨后 +10:30）
  const m = locateMilestones(cal, start, 10 * MIN, Date.parse("2025-04-06T13:00:00Z"));
  // 01:40-01:50 第一次出现 = UTC 15:10-15:20；从休息中起算，50% = 5 分钟 -> 15:15:00
  assert.equal(m.remind50.at, Date.parse("2025-04-05T15:15:00.000Z"));
  assert.equal(computeWorkMs(cal, start, m.remind50.at!), 5 * MIN);
});
