const { test } = require("node:test");
const assert = require("node:assert/strict");
const { elapsed, advance, inspectLead } = require("../dist/index.js");

const MIN = 60_000;
const HOUR = 3_600_000;
const z = (iso) => Date.parse(iso);

// 2024-11-03 为纽约回拨日：02:00 EDT -> 01:00 EST，钟面 01:00-02:00 出现两次。
const dstCalendar = {
  timeZone: "America/New_York",
  weekly: [[], [], [], [], [], [], []],
  exceptions: { "2024-11-03": [{ start: "01:30", end: "01:45" }] },
};

test("回拨日：重复的钟面窗口两次都计入营业耗时", () => {
  // 01:30-01:45 EDT = 05:30-05:45Z，01:30-01:45 EST = 06:30-06:45Z
  assert.equal(
    elapsed(dstCalendar, z("2024-11-03T05:00:00Z"), z("2024-11-03T07:00:00Z")),
    30 * MIN,
  );
});

test("回拨日：advance 跨过两段互不相连的真实时间", () => {
  // 第一段贡献 15 分钟，余下 5 分钟落在第二段 06:30Z 之后
  assert.equal(
    advance(dstCalendar, z("2024-11-03T05:00:00Z"), 20 * MIN),
    z("2024-11-03T06:35:00Z"),
  );
});

// 周一至周五 09:00-13:00（每天恰好 4 小时），周末休息，2025-01-06（周一）例外休息。
const leadCalendar = {
  timeZone: "UTC",
  weekly: [
    [],
    [{ start: "09:00", end: "13:00" }],
    [{ start: "09:00", end: "13:00" }],
    [{ start: "09:00", end: "13:00" }],
    [{ start: "09:00", end: "13:00" }],
    [{ start: "09:00", end: "13:00" }],
    [],
  ],
  exceptions: { "2025-01-06": [] },
};
const createdAt = z("2025-01-03T09:00:00Z"); // 周五开门即创建

test("线索：恰好累计 4 小时后闭店，闭店期间不超时", () => {
  // 周五 13:00Z 恰好满 4 小时，之后周末 + 例外休息日一直闭店
  const duringClose = inspectLead(leadCalendar, createdAt, null, z("2025-01-06T12:00:00Z"));
  assert.equal(duringClose.elapsedBusinessMs, 4 * HOUR);
  assert.equal(duringClose.breached, false);
});

test("线索：重新营业经过 1 毫秒后才超时", () => {
  const justReopened = inspectLead(leadCalendar, createdAt, null, z("2025-01-07T09:00:00Z"));
  assert.equal(justReopened.breached, false);
  const oneMsLater = inspectLead(leadCalendar, createdAt, null, z("2025-01-07T09:00:00.001Z"));
  assert.equal(oneMsLater.elapsedBusinessMs, 4 * HOUR + 1);
  assert.equal(oneMsLater.breached, true);
});

test("线索：闭店期间首次跟进，之后永远不会超时", () => {
  const acted = inspectLead(
    leadCalendar,
    createdAt,
    z("2025-01-05T10:00:00Z"), // 周日闭店期间跟进
    z("2025-01-08T12:00:00Z"),
  );
  assert.equal(acted.elapsedBusinessMs, 4 * HOUR);
  assert.equal(acted.breached, false);
});

test("advance：预算为零返回 from；预算恰好在闭店时耗尽返回闭店时刻", () => {
  assert.equal(advance(leadCalendar, createdAt, 0), createdAt);
  assert.equal(advance(leadCalendar, createdAt, 4 * HOUR), z("2025-01-03T13:00:00Z"));
});

test("elapsed：重叠窗口按并集计时，支持 24:00 收尾", () => {
  const cal = {
    timeZone: "UTC",
    weekly: [[], [], [], [], [], [], []],
    exceptions: {
      "2025-03-01": [
        { start: "09:00", end: "12:00" },
        { start: "11:00", end: "14:00" },
        { start: "20:00", end: "24:00" },
      ],
    },
  };
  const day = (h) => z(`2025-03-01T${String(h).padStart(2, "0")}:00:00Z`);
  assert.equal(elapsed(cal, day(0), z("2025-03-02T00:00:00Z")), 5 * HOUR + 4 * HOUR);
  // 24:00 窗口覆盖到当日最后一毫秒
  assert.equal(elapsed(cal, day(23), z("2025-03-02T00:00:00Z")), HOUR);
});
