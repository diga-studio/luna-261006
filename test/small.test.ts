import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RevenueLedger } from "../src/ledger";
import { parseDate, formatDate } from "../src/date";
import { oracleRange, OracleItem, OracleRefund } from "./oracle";

function tmpDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-test-"));
  return path.join(dir, "test.db");
}

function toOracleItems(items: Array<{ id: string; amount: bigint; startDate: string; endDate: string }>): OracleItem[] {
  return items.map((i) => ({
    id: i.id,
    amount: i.amount,
    startDay: parseDate(i.startDate),
    days: parseDate(i.endDate) - parseDate(i.startDate),
  }));
}

function toOracleRefunds(refunds: Array<{ itemId: string; amount: bigint; effectiveDate: string }>): OracleRefund[] {
  return refunds.map((r) => ({ itemId: r.itemId, day: parseDate(r.effectiveDate), amount: r.amount }));
}

function assertReportMatchesOracle(
  ledger: RevenueLedger,
  items: OracleItem[],
  refunds: OracleRefund[],
  from: string,
  to: string,
): void {
  const report = ledger.exportRange(from, to);
  const oracle = oracleRange(items, refunds, parseDate(from), parseDate(to));
  let sum = 0n;
  let cumRevenue = 0n;
  for (const day of report.days) {
    const o = oracle.get(parseDate(day.date))!;
    assert.equal(day.revenue, o.revenue, `revenue at ${day.date}`);
    assert.equal(day.deferred, o.deferred, `deferred at ${day.date}`);
    sum += day.revenue;
    // 不变量：截至当日 预付款 - 退款 = 累计收入 + 递延余额
    cumRevenue += day.revenue;
    let prepaid = 0n;
    let refunded = 0n;
    const d = parseDate(day.date);
    for (const it of items) if (it.startDay <= d) prepaid += it.amount;
    for (const r of refunds) if (r.day <= d) refunded += r.amount;
    assert.equal(prepaid - refunded, cumRevenue + day.deferred, `invariant at ${day.date}`);
  }
  assert.equal(report.totalRevenue, sum, "totalRevenue equals sum of daily revenue");
}

test("尾差归服务最后一天", () => {
  const db = tmpDb();
  const ledger = new RevenueLedger(db);
  ledger.recordItems([{ id: "a", amount: 100n, startDate: "2025-01-01", endDate: "2025-01-04" }]);
  ledger.advanceTo("2025-01-10");
  const report = ledger.exportRange("2025-01-01", "2025-01-06");
  assert.deepEqual(
    report.days.map((d) => d.revenue),
    [33n, 33n, 34n, 0n, 0n, 0n],
  );
  assert.deepEqual(
    report.days.map((d) => d.deferred),
    [67n, 34n, 0n, 0n, 0n, 0n],
  );
  ledger.close();
});

test("乱序退款与同日拆分退款", () => {
  const items = [{ id: "a", amount: 1000n, startDate: "2025-01-01", endDate: "2025-01-11" }];
  // 乱序：先生效日晚录入；同日拆分：01-06 两笔合计 250
  const refundsDisordered = [
    { itemId: "a", amount: 100n, effectiveDate: "2025-01-08" },
    { itemId: "a", amount: 200n, effectiveDate: "2025-01-06" },
    { itemId: "a", amount: 50n, effectiveDate: "2025-01-06" },
    { itemId: "a", amount: 300n, effectiveDate: "2025-01-03" },
  ];
  const refundsOrderedMerged = [
    { itemId: "a", amount: 300n, effectiveDate: "2025-01-03" },
    { itemId: "a", amount: 250n, effectiveDate: "2025-01-06" },
    { itemId: "a", amount: 100n, effectiveDate: "2025-01-08" },
  ];

  const db1 = tmpDb();
  const l1 = new RevenueLedger(db1);
  l1.recordItems(items);
  l1.recordRefunds(refundsDisordered.slice(0, 2));
  l1.recordRefunds(refundsDisordered.slice(2));
  l1.advanceTo("2025-01-20");

  const db2 = tmpDb();
  const l2 = new RevenueLedger(db2);
  l2.recordItems(items);
  l2.recordRefunds(refundsOrderedMerged);
  l2.advanceTo("2025-01-20");

  const r1 = l1.exportRange("2025-01-01", "2025-01-20");
  const r2 = l2.exportRange("2025-01-01", "2025-01-20");
  assert.deepEqual(r1.days, r2.days, "录入顺序与批次不影响逐日结果");
  assertReportMatchesOracle(l1, toOracleItems(items), toOracleRefunds(refundsDisordered), "2025-01-01", "2025-01-20");
  l1.close();
  l2.close();
});

test("服务结束后全额退款冲减收入且不产生递延", () => {
  const items = [{ id: "a", amount: 900n, startDate: "2025-01-01", endDate: "2025-01-10" }];
  const refunds = [{ itemId: "a", amount: 900n, effectiveDate: "2025-02-01" }];
  const db = tmpDb();
  const ledger = new RevenueLedger(db);
  ledger.recordItems(items);
  ledger.advanceTo("2025-01-15");
  ledger.recordRefunds(refunds); // 未来退款，提前登记
  ledger.advanceTo("2025-02-05");
  const report = ledger.exportRange("2025-01-01", "2025-02-05");
  const at = (date: string) => report.days.find((d) => d.date === date)!;
  assert.equal(at("2025-01-09").deferred, 0n, "服务期末递延清零");
  assert.equal(at("2025-02-01").revenue, -900n, "生效日冲减全部已确认收入");
  assert.equal(at("2025-02-01").deferred, 0n, "服务结束后退款不产生递延");
  assert.equal(at("2025-02-05").deferred, 0n);
  assertReportMatchesOracle(ledger, toOracleItems(items), toOracleRefunds(refunds), "2025-01-01", "2025-02-05");
  ledger.close();
});

test("一次封账与逐日/分段推进逐日完全一致", () => {
  // 确定性伪随机数据
  let seed = 7;
  const rnd = (n: number): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  const items: Array<{ id: string; amount: bigint; startDate: string; endDate: string }> = [];
  const refunds: Array<{ itemId: string; amount: bigint; effectiveDate: string }> = [];
  const base = parseDate("2025-01-01");
  for (let i = 0; i < 50; i++) {
    const start = base + rnd(300);
    const days = 1 + rnd(400);
    const amount = BigInt(1 + rnd(100000));
    items.push({ id: `item-${i}`, amount, startDate: formatDate(start), endDate: formatDate(start + days) });
    let total = 0n;
    const nR = rnd(4);
    for (let j = 0; j < nR; j++) {
      const day = start + rnd(days + 60);
      const amt = BigInt(1 + rnd(20000));
      if (total + amt > amount) continue;
      total += amt;
      refunds.push({ itemId: `item-${i}`, amount: amt, effectiveDate: formatDate(day) });
    }
  }
  const shuffled = [...refunds].sort(() => rnd(3) - 1);
  const end = "2027-06-01";

  // 模式一：一次封至末日
  const l1 = new RevenueLedger(tmpDb());
  l1.recordItems(items);
  l1.recordRefunds(shuffled);
  l1.advanceTo(end);

  // 模式二：逐日推进 + 分批交错录入未来退款
  const l2 = new RevenueLedger(tmpDb());
  l2.recordItems(items.slice(0, 25));
  l2.recordItems(items.slice(25));
  const batches: Array<Array<(typeof shuffled)[number]>> = [[], [], [], []];
  // 按生效日排序后交替装入 4 批，每批内部乱序但保证生效日不早于装入时的封账线
  const sorted = [...shuffled].sort((a, b) => parseDate(a.effectiveDate) - parseDate(b.effectiveDate));
  const q = Math.ceil(sorted.length / 4);
  for (let i = 0; i < sorted.length; i++) batches[Math.floor(i / q)].push(sorted[i]);
  let cursor = parseDate("2025-01-01");
  const endDay = parseDate(end);
  for (let b = 0; b < 4; b++) {
    l2.recordRefunds(batches[b]);
    const nextBoundary = b < 3 && batches[b + 1].length > 0
      ? parseDate(batches[b + 1][0].effectiveDate) - 1
      : endDay;
    while (cursor <= Math.min(nextBoundary, endDay)) {
      l2.advanceTo(formatDate(cursor));
      cursor++;
    }
  }
  while (cursor <= endDay) {
    l2.advanceTo(formatDate(cursor));
    cursor++;
  }

  // 模式三：按月推进
  const l3 = new RevenueLedger(tmpDb());
  l3.recordItems(items);
  l3.recordRefunds(shuffled);
  let m = parseDate("2025-01-31");
  while (m < endDay) {
    l3.advanceTo(formatDate(m));
    m += 31;
    m = Math.min(m, endDay);
  }
  l3.advanceTo(end);

  const r1 = l1.exportRange("2025-01-01", end);
  const r2 = l2.exportRange("2025-01-01", end);
  const r3 = l3.exportRange("2025-01-01", end);
  assert.deepEqual(r1.days, r2.days, "一次封账 vs 逐日推进");
  assert.deepEqual(r1.days, r3.days, "一次封账 vs 按月推进");
  assert.equal(r1.totalRevenue, r2.totalRevenue);
  assertReportMatchesOracle(l1, toOracleItems(items), toOracleRefunds(shuffled), "2025-01-01", end);
  l1.close();
  l2.close();
  l3.close();
});

test("金额汇总超过安全整数仍精确", () => {
  const big = 10n ** 18n;
  const items = [
    { id: "a", amount: big, startDate: "2025-01-01", endDate: "2026-01-01" },
    { id: "b", amount: big, startDate: "2025-01-01", endDate: "2026-01-01" },
    { id: "c", amount: big, startDate: "2025-01-01", endDate: "2026-01-01" },
  ];
  const db = tmpDb();
  const ledger = new RevenueLedger(db);
  ledger.recordItems(items);
  ledger.advanceTo("2025-01-02");
  const report = ledger.exportRange("2025-01-01", "2025-01-02");
  // 3 * 10^18 远超 2^53
  assert.equal(report.days[0].deferred + report.days[0].revenue, 3n * big);
  assert.equal(report.days[0].deferred, 3n * big - 3n * (big / 365n));
  ledger.close();
});

test("非法输入与封账线保护", () => {
  const db = tmpDb();
  const ledger = new RevenueLedger(db);
  ledger.recordItems([{ id: "a", amount: 100n, startDate: "2025-01-01", endDate: "2025-02-01" }]);
  assert.throws(() => ledger.recordItems([{ id: "a", amount: 1n, startDate: "2025-01-01", endDate: "2025-01-02" }]), /duplicate/);
  assert.throws(() => ledger.recordItems([{ id: "b", amount: 0n, startDate: "2025-01-01", endDate: "2025-01-02" }]), /amount/);
  assert.throws(() => ledger.recordItems([{ id: "b", amount: 1n, startDate: "2025-01-01", endDate: "2025-01-01" }]), /service days/);
  assert.throws(() => ledger.recordItems([{ id: "b", amount: 1n, startDate: "2025-01-01", endDate: "2036-01-01" }]), /service days/);
  assert.throws(() => ledger.recordRefunds([{ itemId: "zz", amount: 1n, effectiveDate: "2025-01-05" }]), /unknown item/);
  assert.throws(() => ledger.recordRefunds([{ itemId: "a", amount: 1n, effectiveDate: "2024-12-31" }]), /predates/);
  assert.throws(() => ledger.recordRefunds([{ itemId: "a", amount: 101n, effectiveDate: "2025-01-05" }]), /exceed/);
  assert.throws(() => ledger.exportRange("2025-01-01", "2025-01-10"), /not fully closed/);

  ledger.recordRefunds([{ itemId: "a", amount: 40n, effectiveDate: "2025-01-10" }]);
  ledger.advanceTo("2025-01-15");
  assert.throws(() => ledger.advanceTo("2025-01-14"), /backwards/);
  assert.throws(() => ledger.recordRefunds([{ itemId: "a", amount: 1n, effectiveDate: "2025-01-15" }]), /closed frontier/);
  assert.throws(() => ledger.recordItems([{ id: "c", amount: 1n, startDate: "2025-01-10", endDate: "2025-02-10" }]), /closed frontier/);
  // 已封结果不受后续录入影响
  const before = ledger.exportRange("2025-01-01", "2025-01-15");
  ledger.recordRefunds([{ itemId: "a", amount: 60n, effectiveDate: "2025-03-01" }]);
  const after = ledger.exportRange("2025-01-01", "2025-01-15");
  assert.deepEqual(before.days, after.days, "已封结果不可变化");
  ledger.close();
});

test("重开数据库后状态与结果保持", () => {
  const db = tmpDb();
  const items = [{ id: "a", amount: 1000n, startDate: "2025-01-01", endDate: "2025-01-11" }];
  const refunds = [{ itemId: "a", amount: 300n, effectiveDate: "2025-01-06" }];
  const l1 = new RevenueLedger(db);
  l1.recordItems(items);
  l1.recordRefunds(refunds);
  l1.advanceTo("2025-01-08");
  l1.close();

  const l2 = new RevenueLedger(db);
  assert.equal(l2.frontier, "2025-01-08");
  l2.advanceTo("2025-01-20");
  assertReportMatchesOracle(l2, toOracleItems(items), toOracleRefunds(refunds), "2025-01-01", "2025-01-20");
  l2.close();
});
