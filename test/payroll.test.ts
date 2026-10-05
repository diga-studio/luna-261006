import { test } from "node:test";
import assert from "node:assert/strict";
import { settlePayroll } from "../src/index.js";
import type {
  RateChange,
  RationalValue,
  WorkRecord,
} from "../src/index.js";

const sec = (iso: string): number => Date.parse(iso) / 1000;

function rec(employeeId: string, startIso: string, endIso: string): WorkRecord {
  return { employeeId, startUtc: sec(startIso), endUtc: sec(endIso) };
}

function rate(employeeId: string, effectiveIso: string, centsPerHour: number): RateChange {
  return { employeeId, effectiveUtc: sec(effectiveIso), centsPerHour };
}

/** 独立精确比较：num/den 与期望分数相等（交叉相乘）。 */
function assertFraction(
  actual: RationalValue,
  expectedNum: bigint,
  expectedDen: bigint,
  message: string,
): void {
  assert.ok(
    actual.numerator * expectedDen === expectedNum * actual.denominator,
    `${message}: expected ${expectedNum}/${expectedDen}, got ${actual.numerator}/${actual.denominator}`,
  );
}

// ---------------------------------------------------------------------------
// 场景一：月末落在周中，月末前已超过 40 小时，周后半段发生调薪。
//
// 自然周：2026-09-28（周一）至 2026-10-05（周一），EDT (UTC-4)。
// 工作：周一至周五每天 07:00–21:00 本地（14h/天，共 70h）。
// 费率：2000 分/h，周四 2026-10-01 12:00 本地起调整为 3200 分/h。
// 月末 10-01 00:00 本地落在周四凌晨（周中）。
// 累计：周一 14h、周二 28h、周三 42h —— 月末前已超 40h，周三 23:00Z 起算加班。
// 整周基础工资 = 42*2000 + 5*2000 + 9*3200 + 14*3200 = 167600 分。
// 整周平均时薪 = 167600/70 分/h（含周四调薪后的费率）。
// ---------------------------------------------------------------------------
const EMP = "emp-1";

const scenarioRates: RateChange[] = [
  rate(EMP, "2026-09-01T00:00:00Z", 2000),
  rate(EMP, "2026-10-01T16:00:00Z", 3200), // 周四 12:00 本地
];

const scenarioRecords: WorkRecord[] = [
  rec(EMP, "2026-09-28T11:00:00Z", "2026-09-29T01:00:00Z"), // 周一
  rec(EMP, "2026-09-29T11:00:00Z", "2026-09-30T01:00:00Z"), // 周二
  rec(EMP, "2026-09-30T11:00:00Z", "2026-10-01T01:00:00Z"), // 周三
  rec(EMP, "2026-10-01T11:00:00Z", "2026-10-02T01:00:00Z"), // 周四
  rec(EMP, "2026-10-02T11:00:00Z", "2026-10-03T01:00:00Z"), // 周五
];

test("月末在周中：相邻区间之和等于合并区间，加班补差反映后半周费率", () => {
  const [a] = settlePayroll(scenarioRecords, scenarioRates, {
    startLocalDate: "2026-09-01",
    endLocalDate: "2026-10-01",
  });
  const [b] = settlePayroll(scenarioRecords, scenarioRates, {
    startLocalDate: "2026-10-01",
    endLocalDate: "2026-11-01",
  });
  const [combined] = settlePayroll(scenarioRecords, scenarioRates, {
    startLocalDate: "2026-09-01",
    endLocalDate: "2026-11-01",
  });

  // 区间 A：9 月内的 42h（40 普通 + 2 加班），全部按 2000 分/h 计基础工资。
  assertFraction(a.basePay, 84000n, 1n, "A base");
  // 区间 A 的加班补差必须使用整周平均时薪 167600/70，而非当月费率 2000。
  // 0.5 * (167600/70) * 2h = 167600/70 分。
  assertFraction(a.overtimePremium, 167600n, 70n, "A premium reflects late-week rate");
  assert.notEqual(
    a.overtimePremium.numerator * 1n,
    2000n * a.overtimePremium.denominator,
    "A premium must not be computed with the 2000-only rate",
  );

  // 区间 B：周四 5h*2000 + 9h*3200 + 周五 14h*3200 = 83600；加班 28h。
  assertFraction(b.basePay, 83600n, 1n, "B base");
  // 0.5 * (167600/70) * 28h = 33520 分。
  assertFraction(b.overtimePremium, 33520n, 1n, "B premium");

  // 合并区间：基础工资 167600；加班 30h，补差 0.5*(167600/70)*30 = 2514000/70。
  assertFraction(combined.basePay, 167600n, 1n, "combined base");
  assertFraction(combined.overtimePremium, 2514000n, 70n, "combined premium");

  // 两个相邻区间的未舍入金额之和必须等于合并区间。
  const sum = (x: RationalValue, y: RationalValue): [bigint, bigint] => [
    x.numerator * y.denominator + y.numerator * x.denominator,
    x.denominator * y.denominator,
  ];
  const [baseNum, baseDen] = sum(a.basePay, b.basePay);
  assertFraction(
    { numerator: baseNum, denominator: baseDen },
    combined.basePay.numerator,
    combined.basePay.denominator,
    "base A+B == combined",
  );
  const [otNum, otDen] = sum(a.overtimePremium, b.overtimePremium);
  assertFraction(
    { numerator: otNum, denominator: otDen },
    combined.overtimePremium.numerator,
    combined.overtimePremium.denominator,
    "premium A+B == combined",
  );

  // 舍入：合计后四舍五入到分。
  assert.equal(a.totalRoundedCents, 86394n); // 84000 + 2394.285714…
  assert.equal(b.totalRoundedCents, 117120n);
  assert.equal(combined.totalRoundedCents, 203514n); // 167600 + 35914.285714…
});

test("记录顺序与班次拆分不改变结果", () => {
  // 同一班次拆成多条连续记录，加入重复记录，并打乱顺序。
  const shuffled: WorkRecord[] = [
    rec(EMP, "2026-10-02T11:00:00Z", "2026-10-02T18:00:00Z"), // 周五前半
    rec(EMP, "2026-09-28T11:00:00Z", "2026-09-28T17:00:00Z"), // 周一前段
    rec(EMP, "2026-09-30T11:00:00Z", "2026-10-01T01:00:00Z"), // 周三整条
    rec(EMP, "2026-09-28T17:00:00Z", "2026-09-28T21:00:00Z"), // 周一中段
    rec(EMP, "2026-10-01T11:00:00Z", "2026-10-02T01:00:00Z"), // 周四整条
    rec(EMP, "2026-09-28T21:00:00Z", "2026-09-29T01:00:00Z"), // 周一末段
    rec(EMP, "2026-09-30T11:00:00Z", "2026-10-01T01:00:00Z"), // 周三重复
    rec(EMP, "2026-10-02T18:00:00Z", "2026-10-03T01:00:00Z"), // 周五后半
    rec(EMP, "2026-09-29T11:00:00Z", "2026-09-30T01:00:00Z"), // 周二整条
  ];
  const [split] = settlePayroll(shuffled, scenarioRates, {
    startLocalDate: "2026-09-01",
    endLocalDate: "2026-11-01",
  });
  const [plain] = settlePayroll(scenarioRecords, scenarioRates, {
    startLocalDate: "2026-09-01",
    endLocalDate: "2026-11-01",
  });
  assertFraction(split.basePay, plain.basePay.numerator, plain.basePay.denominator, "split base");
  assertFraction(
    split.overtimePremium,
    plain.overtimePremium.numerator,
    plain.overtimePremium.denominator,
    "split premium",
  );
  assert.equal(split.totalRoundedCents, plain.totalRoundedCents);
});

// ---------------------------------------------------------------------------
// 场景二：DST 切换日的班次时长、重复/交叠去重、跨周归属。
// 2026 年东部时间：3 月 8 日 02:00 拨快（春季），11 月 1 日 02:00 拨回（秋季）。
// ---------------------------------------------------------------------------
const DST_RATE: RateChange[] = [rate(EMP, "2026-01-01T00:00:00Z", 2400)];

test("春季切换日 00:00–04:00 班次计 3 小时，跨周记录正确归属", () => {
  const records: WorkRecord[] = [
    // 本地 2026-03-08（周日）00:00–04:00：UTC 05:00–08:00，实际 3 小时。
    rec(EMP, "2026-03-08T05:00:00Z", "2026-03-08T08:00:00Z"),
    // 完全重复的记录。
    rec(EMP, "2026-03-08T05:00:00Z", "2026-03-08T08:00:00Z"),
    // 与上班次交叠的记录。
    rec(EMP, "2026-03-08T06:00:00Z", "2026-03-08T07:30:00Z"),
    // 跨周：本地周日 22:00 至周一 02:00（UTC 03-09 02:00–06:00），
    // 周界为本地周一 00:00 = UTC 04:00，前后各 2 小时。
    rec(EMP, "2026-03-09T02:00:00Z", "2026-03-09T06:00:00Z"),
  ];

  // 第一周（3-2 至 3-9）：3h + 2h = 5h，全部普通工时。
  const [before] = settlePayroll(records, DST_RATE, {
    startLocalDate: "2026-03-01",
    endLocalDate: "2026-03-09",
  });
  assertFraction(before.basePay, 5n * 2400n, 1n, "spring week1 base = 5h");
  assertFraction(before.overtimePremium, 0n, 1n, "spring week1 no overtime");

  // 第二周（3-9 至 3-16）：2h。
  const [after] = settlePayroll(records, DST_RATE, {
    startLocalDate: "2026-03-09",
    endLocalDate: "2026-03-20",
  });
  assertFraction(after.basePay, 2n * 2400n, 1n, "spring week2 base = 2h");

  // 合并区间：7h，每秒只计一次。
  const [all] = settlePayroll(records, DST_RATE, {
    startLocalDate: "2026-03-01",
    endLocalDate: "2026-03-20",
  });
  assertFraction(all.basePay, 7n * 2400n, 1n, "spring total = 7h");
  assert.equal(all.totalRoundedCents, 7n * 2400n);
});

test("秋季切换日 00:00–04:00 班次计 5 小时，重复与交叠只计一次", () => {
  const records: WorkRecord[] = [
    // 本地 2026-11-01（周日）00:00–04:00：UTC 04:00–09:00，实际 5 小时。
    rec(EMP, "2026-11-01T04:00:00Z", "2026-11-01T09:00:00Z"),
    // 完全重复。
    rec(EMP, "2026-11-01T04:00:00Z", "2026-11-01T09:00:00Z"),
    // 交叠且横跨重复出现的 01:00 小时。
    rec(EMP, "2026-11-01T05:30:00Z", "2026-11-01T07:30:00Z"),
  ];
  const [result] = settlePayroll(records, DST_RATE, {
    startLocalDate: "2026-11-01",
    endLocalDate: "2026-11-08",
  });
  assertFraction(result.basePay, 5n * 2400n, 1n, "fall base = 5h");
  assertFraction(result.overtimePremium, 0n, 1n, "fall no overtime");
  assert.equal(result.totalRoundedCents, 5n * 2400n);
});

test("正好半分时向上舍入", () => {
  // 1 秒工时，费率 1800 分/h：基础工资 = 1800/3600 = 0.5 分 → 向上为 1 分。
  const [result] = settlePayroll(
    [rec(EMP, "2026-06-01T12:00:00Z", "2026-06-01T12:00:01Z")],
    [rate(EMP, "2026-06-01T00:00:00Z", 1800)],
    { startLocalDate: "2026-06-01", endLocalDate: "2026-06-02" },
  );
  assertFraction(result.basePay, 1n, 2n, "half cent base");
  assert.equal(result.totalRoundedCents, 1n);
});

test("不同员工独立核算", () => {
  const records: WorkRecord[] = [
    rec("emp-a", "2026-06-01T12:00:00Z", "2026-06-01T14:00:00Z"), // 2h
    rec("emp-b", "2026-06-01T12:00:00Z", "2026-06-01T15:00:00Z"), // 3h
    rec("emp-a", "2026-06-01T13:00:00Z", "2026-06-01T16:00:00Z"), // 与自身交叠，并集 4h
  ];
  const rates: RateChange[] = [
    rate("emp-a", "2026-06-01T00:00:00Z", 1000),
    rate("emp-b", "2026-06-01T00:00:00Z", 3000),
  ];
  const results = settlePayroll(records, rates, {
    startLocalDate: "2026-06-01",
    endLocalDate: "2026-06-02",
  });
  assert.equal(results.length, 2);
  assert.equal(results[0].employeeId, "emp-a");
  assert.equal(results[1].employeeId, "emp-b");
  assertFraction(results[0].basePay, 4n * 1000n, 1n, "emp-a 4h at own rate");
  assertFraction(results[1].basePay, 3n * 3000n, 1n, "emp-b 3h at own rate");
});
