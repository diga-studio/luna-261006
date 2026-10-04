import { test } from "node:test";
import { deepEqual, equal, ok, throws } from "node:assert/strict";
import { accumulateWorkMs, locateMilestones } from "../src/index.js";
import type { Milestones, TimeInterval, WorkCalendar } from "../src/index.js";

const MIN = 60_000;
const HOUR = 3_600_000;

function emptyWeek(): TimeInterval[][] {
  return [[], [], [], [], [], [], []];
}

function cal(partial: Partial<WorkCalendar> & { timeZone: string }): WorkCalendar {
  return { weekly: emptyWeek(), exceptions: {}, ...partial };
}

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

function isoAll(m: Milestones): Record<string, string | null> {
  return { remind50: iso(m.remind50), remind80: iso(m.remind80), deadline: iso(m.deadline) };
}

/** 验证累计与定位相互吻合：从 start 到各里程碑的累计时长必须等于对应额度。 */
function assertConsistent(
  calendar: WorkCalendar,
  startUtc: number,
  slaMs: number,
  maxUtc: number,
): Milestones {
  const m = locateMilestones(calendar, startUtc, slaMs, maxUtc);
  const quotas: Array<[number | null, number, string]> = [
    [m.remind50, Math.ceil(slaMs * 0.5), "remind50"],
    [m.remind80, Math.ceil(slaMs * 0.8), "remind80"],
    [m.deadline, slaMs, "deadline"],
  ];
  for (const [hit, quota, name] of quotas) {
    if (hit !== null) {
      equal(
        accumulateWorkMs(calendar, startUtc, hit),
        quota,
        `${name}: accumulated work up to milestone must equal quota`,
      );
      ok(hit >= startUtc && hit <= maxUtc, `${name}: milestone within search range`);
    } else {
      ok(
        accumulateWorkMs(calendar, startUtc, maxUtc) < quota,
        `${name}: unreachable milestone must not be satisfiable within range`,
      );
    }
  }
  return m;
}

test("America/New_York 2025-11-02 重复时段 01:15-01:45 计 60 分钟", () => {
  const calendar = cal({
    timeZone: "America/New_York",
    exceptions: { "2025-11-02": [{ startMinutes: 75, endMinutes: 105 }] },
  });
  const total = accumulateWorkMs(
    calendar,
    Date.UTC(2025, 10, 2),
    Date.UTC(2025, 10, 3),
  );
  equal(total, 60 * MIN);
});

test("America/New_York 2025-11-02 从 05:30Z 起 30 分钟额度的三个里程碑", () => {
  const calendar = cal({
    timeZone: "America/New_York",
    exceptions: { "2025-11-02": [{ startMinutes: 75, endMinutes: 105 }] },
  });
  const m = assertConsistent(
    calendar,
    Date.UTC(2025, 10, 2, 5, 30),
    30 * MIN,
    Date.UTC(2025, 10, 3),
  );
  deepEqual(isoAll(m), {
    remind50: "2025-11-02T05:45:00.000Z",
    remind80: "2025-11-02T06:24:00.000Z",
    deadline: "2025-11-02T06:30:00.000Z",
  });
});

test("America/New_York 2025-03-09 跳过时段 02:15-03:15 只计 15 分钟", () => {
  const calendar = cal({
    timeZone: "America/New_York",
    exceptions: { "2025-03-09": [{ startMinutes: 135, endMinutes: 195 }] },
  });
  const total = accumulateWorkMs(
    calendar,
    Date.UTC(2025, 2, 9),
    Date.UTC(2025, 2, 10),
  );
  equal(total, 15 * MIN);
});

test("Australia/Lord_Howe 2025-04-06 非整小时偏移 01:40-01:50 计 20 分钟", () => {
  const calendar = cal({
    timeZone: "Australia/Lord_Howe",
    exceptions: { "2025-04-06": [{ startMinutes: 100, endMinutes: 110 }] },
  });
  const total = accumulateWorkMs(
    calendar,
    Date.UTC(2025, 3, 5, 12),
    Date.UTC(2025, 3, 6, 12),
  );
  equal(total, 20 * MIN);
});

test("跨午夜区间进入空安排假日尾段仍计时，重叠部分不重复计时", () => {
  // 周一 22:00-02:00 与 23:00-03:00 重叠，并集为 22:00-03:00 共 5 小时；
  // 周二为空例外（假日），不截断周一跨过来的尾段。
  const weekly = emptyWeek();
  weekly[1] = [
    { startMinutes: 22 * 60, endMinutes: 2 * 60 },
    { startMinutes: 23 * 60, endMinutes: 3 * 60 },
  ];
  // 2025-06-09 是周一（America/New_York，无 DST 切换）
  const calendar = cal({
    timeZone: "America/New_York",
    weekly,
    exceptions: { "2025-06-10": [] },
  });
  const total = accumulateWorkMs(
    calendar,
    Date.UTC(2025, 5, 9),
    Date.UTC(2025, 5, 11),
  );
  equal(total, 5 * HOUR);
  // 尾段落在周二本地 00:00-03:00（UTC 04:00-07:00）
  const tail = accumulateWorkMs(
    calendar,
    Date.UTC(2025, 5, 10, 4),
    Date.UTC(2025, 5, 10, 7),
  );
  equal(tail, 3 * HOUR);
});

test("假日之后工作日恢复，假日本身不计时", () => {
  const weekly = emptyWeek();
  weekly[1] = [{ startMinutes: 9 * 60, endMinutes: 17 * 60 }];
  weekly[2] = [{ startMinutes: 9 * 60, endMinutes: 17 * 60 }];
  const calendar = cal({
    timeZone: "America/New_York",
    weekly,
    exceptions: { "2025-06-10": [] },
  });
  const monday = accumulateWorkMs(
    calendar,
    Date.UTC(2025, 5, 9),
    Date.UTC(2025, 5, 10),
  );
  const tuesday = accumulateWorkMs(
    calendar,
    Date.UTC(2025, 5, 10),
    Date.UTC(2025, 5, 11),
  );
  equal(monday, 8 * HOUR);
  equal(tuesday, 0);
});

test("例外完全替换每周安排", () => {
  const weekly = emptyWeek();
  weekly[1] = [{ startMinutes: 9 * 60, endMinutes: 17 * 60 }];
  const calendar = cal({
    timeZone: "America/New_York",
    weekly,
    exceptions: { "2025-06-09": [{ startMinutes: 20 * 60, endMinutes: 21 * 60 }] },
  });
  const total = accumulateWorkMs(
    calendar,
    Date.UTC(2025, 5, 8),
    Date.UTC(2025, 5, 12),
  );
  equal(total, 1 * HOUR);
});

test("查找范围不足时部分里程碑不可达，最晚查找时刻本身可成为里程碑", () => {
  const calendar = cal({
    timeZone: "America/New_York",
    exceptions: { "2025-11-02": [{ startMinutes: 75, endMinutes: 105 }] },
  });
  // 从 05:30Z 起 40 分钟额度，maxUtc=06:20Z：
  // 50% 额度 20 分钟恰好在 06:20Z 耗尽（边界保留）；80% 与到期不可达。
  const m = assertConsistent(
    calendar,
    Date.UTC(2025, 10, 2, 5, 30),
    40 * MIN,
    Date.UTC(2025, 10, 2, 6, 20),
  );
  deepEqual(isoAll(m), {
    remind50: "2025-11-02T06:20:00.000Z",
    remind80: null,
    deadline: null,
  });
});

test("额度恰好在下班边界耗尽时取该边界，不顺延", () => {
  const weekly = emptyWeek();
  weekly[1] = [{ startMinutes: 9 * 60, endMinutes: 17 * 60 }];
  weekly[2] = [{ startMinutes: 9 * 60, endMinutes: 17 * 60 }];
  const calendar = cal({ timeZone: "America/New_York", weekly });
  // 周一 09:00 本地 = 13:00Z（6 月 EDT），8 小时额度正好在 17:00 下班边界耗尽
  const m = assertConsistent(
    calendar,
    Date.UTC(2025, 5, 9, 13),
    8 * HOUR,
    Date.UTC(2025, 5, 20),
  );
  equal(iso(m.deadline), "2025-06-09T21:00:00.000Z");
});

test("开始时刻落在休息时间时休息部分不消耗额度", () => {
  const weekly = emptyWeek();
  weekly[1] = [{ startMinutes: 9 * 60, endMinutes: 17 * 60 }];
  const calendar = cal({ timeZone: "America/New_York", weekly });
  // 周一 07:00 本地（休息）开始，1 小时额度 -> 10:00 本地到期
  const m = assertConsistent(
    calendar,
    Date.UTC(2025, 5, 9, 11),
    1 * HOUR,
    Date.UTC(2025, 5, 20),
  );
  equal(iso(m.deadline), "2025-06-09T14:00:00.000Z");
  equal(iso(m.remind50), "2025-06-09T13:30:00.000Z");
});

test("起止相同的区间表示延续 24 小时", () => {
  const calendar = cal({
    timeZone: "America/New_York",
    exceptions: { "2025-06-09": [{ startMinutes: 9 * 60, endMinutes: 9 * 60 }] },
  });
  const total = accumulateWorkMs(
    calendar,
    Date.UTC(2025, 5, 9),
    Date.UTC(2025, 5, 11),
  );
  equal(total, 24 * HOUR);
});

test("跨午夜区间被次日区间衔接时重叠部分只计一次", () => {
  // 周一 22:00 - 次日 02:00，周二 01:00 - 03:00，并集 22:00 - 03:00 共 5 小时
  const weekly = emptyWeek();
  weekly[1] = [{ startMinutes: 22 * 60, endMinutes: 2 * 60 }];
  weekly[2] = [{ startMinutes: 1 * 60, endMinutes: 3 * 60 }];
  const calendar = cal({ timeZone: "America/New_York", weekly });
  const total = accumulateWorkMs(
    calendar,
    Date.UTC(2025, 5, 9),
    Date.UTC(2025, 5, 11),
  );
  equal(total, 5 * HOUR);
});

test("多个里程碑可以相同", () => {
  const weekly = emptyWeek();
  weekly[1] = [{ startMinutes: 9 * 60, endMinutes: 17 * 60 }];
  const calendar = cal({ timeZone: "America/New_York", weekly });
  // 1 毫秒额度：ceil(0.5ms)=ceil(0.8ms)=1ms，三个里程碑相同
  const m = locateMilestones(
    calendar,
    Date.UTC(2025, 5, 9, 13),
    1,
    Date.UTC(2025, 5, 20),
  );
  equal(m.remind50, Date.UTC(2025, 5, 9, 13) + 1);
  equal(m.remind80, m.remind50);
  equal(m.deadline, m.remind50);
});

test("提醒额度向上取整到毫秒", () => {
  const weekly = emptyWeek();
  weekly[1] = [{ startMinutes: 9 * 60, endMinutes: 17 * 60 }];
  const calendar = cal({ timeZone: "America/New_York", weekly });
  // 额度 1001ms：50% -> 501ms，80% -> 801ms
  const m = locateMilestones(
    calendar,
    Date.UTC(2025, 5, 9, 13),
    1001,
    Date.UTC(2025, 5, 20),
  );
  equal(m.remind50, Date.UTC(2025, 5, 9, 13) + 501);
  equal(m.remind80, Date.UTC(2025, 5, 9, 13) + 801);
  equal(m.deadline, Date.UTC(2025, 5, 9, 13) + 1001);
});

test("累计与定位在跨 DST 长区间上相互吻合", () => {
  const weekly = emptyWeek();
  for (let d = 1; d <= 5; d++) {
    weekly[d] = [
      { startMinutes: 9 * 60, endMinutes: 12 * 60 },
      { startMinutes: 13 * 60, endMinutes: 18 * 60 },
    ];
  }
  const calendar = cal({ timeZone: "America/New_York", weekly });
  // 横跨 2025 年春秋两次 DST 切换
  const start = Date.UTC(2025, 1, 15, 10);
  const max = Date.UTC(2025, 11, 15, 10);
  assertConsistent(calendar, start, 1000 * HOUR, max);
  assertConsistent(calendar, start, 7 * HOUR + 12345, max);
});

test("非法额度被拒绝", () => {
  const calendar = cal({ timeZone: "America/New_York" });
  throws(() => locateMilestones(calendar, 0, 0, 1000), RangeError);
  throws(() => locateMilestones(calendar, 0, -5, 1000), RangeError);
  throws(() => locateMilestones(calendar, 0, 1.5, 1000), RangeError);
});

test("空区间与反向区间累计为零", () => {
  const calendar = cal({ timeZone: "America/New_York" });
  equal(accumulateWorkMs(calendar, 1000, 1000), 0);
  equal(accumulateWorkMs(calendar, 2000, 1000), 0);
});
