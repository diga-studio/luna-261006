import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openPlan, type Plan } from "../src/plan.js";
import type { Inspection, PlanSeed } from "../src/types.js";

const FEE_DELAY = 259200;
const START = 1_000_000;

function tmpPath(): string {
  return join(mkdtempSync(join(tmpdir(), "splitcart-")), "plan.db");
}

/** 5 期，每期本金 1000，dueAt 间隔 10000 秒。 */
function seed5(): PlanSeed {
  return {
    startAt: START,
    installments: [0, 1, 2, 3, 4].map((i) => ({
      principal: 1000,
      dueAt: START + 10_000 * (i + 1),
    })),
  };
}

function fees(snap: Inspection): number[] {
  return snap.installments.map((i) => i.feeRemaining);
}

function principals(snap: Inspection): number[] {
  return snap.installments.map((i) => i.principalRemaining);
}

test("费用封顶后晚到确认清偿最早期，名额转移并重分配已有到账", () => {
  const plan = openPlan(tmpPath(), seed5());
  // T_i = dueAt_i + 259200 → 1_269_200, 1_279_200, 1_289_200, 1_299_200, 1_309_200
  plan.advanceTo(1_299_200);
  let snap = plan.inspect();
  // 无还款：期 0/1/2 各计提 500，累计 1500 达上限，期 3 无费用。
  assert.deepEqual(fees(snap), [500, 500, 500, 0, 0]);
  assert.deepEqual(principals(snap), [1000, 1000, 1000, 1000, 1000]);

  // 已有到账 700：先抵费用，期0费用 500 + 期1费用 200。
  plan.confirm("pay-a", 1_295_000, 700);
  snap = plan.inspect();
  assert.deepEqual(fees(snap), [0, 300, 500, 0, 0]);
  assert.deepEqual(snap.allocations, [
    { requestId: "pay-a", paidAt: 1_295_000, amount: 700, toPrincipal: 0, toFee: 700, unallocated: 0 },
  ]);

  // 晚到确认：paidAt 早于一切费用检查点，全额抵期0本金。
  plan.confirm("pay-late", 1_260_000, 1000);
  snap = plan.inspect();

  // 期0本金在 T_0 前已清偿 → 期0费用被撤销；封顶名额顺移至期3（第四个符合条件期次）。
  // 时间线重算：pay-late@1_260_000 → 本金0清零；
  //   T_1 计费期1=500，T_2 计费期2=500；
  //   pay-a@1_295_000 → 抵期1费用500 + 期2费用200；
  //   T_3 计费期3=500（累计 1500 达上限）。
  assert.deepEqual(principals(snap), [0, 1000, 1000, 1000, 1000]);
  assert.deepEqual(fees(snap), [0, 0, 300, 500, 0]);
  assert.equal(snap.unallocated, 0);
  // pay-a 的抵扣去向被改写：仍全部抵费用，但对象从 (期0,期1) 变为 (期1,期2)。
  assert.deepEqual(snap.allocations, [
    { requestId: "pay-late", paidAt: 1_260_000, amount: 1000, toPrincipal: 1000, toFee: 0, unallocated: 0 },
    { requestId: "pay-a", paidAt: 1_295_000, amount: 700, toPrincipal: 0, toFee: 700, unallocated: 0 },
  ]);
  plan.close();
});

test("计费时刻恰好到账优先于费用判断；提前结清后超付留存", () => {
  const plan = openPlan(tmpPath(), {
    startAt: START,
    installments: [
      { principal: 1000, dueAt: START + 10_000 },
      { principal: 1000, dueAt: START + 20_000 },
    ],
  });
  const T0 = START + 10_000 + FEE_DELAY; // 1_269_200
  const T1 = START + 20_000 + FEE_DELAY; // 1_279_200

  // 先推进到计费时刻：期0 计提 500。
  plan.advanceTo(T0);
  assert.deepEqual(fees(plan.inspect()), [500, 0]);

  // 补入恰好该时刻的到账 1500：同刻先到账后计费。
  // 到账时无费用 → 抵期0本金1000、期1本金500；随后 T0 检查时本金已清 → 费用撤销。
  plan.confirm("exact", T0, 1500);
  let snap = plan.inspect();
  assert.deepEqual(principals(snap), [0, 500]);
  assert.deepEqual(fees(snap), [0, 0]);
  assert.deepEqual(snap.allocations, [
    { requestId: "exact", paidAt: T0, amount: 1500, toPrincipal: 1500, toFee: 0, unallocated: 0 },
  ]);

  // 超付 1000：抵期1剩余本金 500，其余 500 进入未分配余额。
  plan.confirm("over", T0, 1000);
  snap = plan.inspect();
  assert.deepEqual(principals(snap), [0, 0]);
  assert.deepEqual(fees(snap), [0, 0]);
  assert.equal(snap.unallocated, 500);
  assert.deepEqual(snap.allocations[1], {
    requestId: "over", paidAt: T0, amount: 1000, toPrincipal: 500, toFee: 0, unallocated: 500,
  });

  // 推进过期1计费时刻：本金已清，不产生费用；超付留存的 500 不被挪用。
  plan.advanceTo(T1);
  snap = plan.inspect();
  assert.deepEqual(fees(snap), [0, 0]);
  assert.equal(snap.unallocated, 500);
  plan.close();
});

test("结果与确认接收顺序、逾期扫描次数无关", () => {
  const pathA = tmpPath();
  const pathB = tmpPath();
  const a = openPlan(pathA, seed5());
  const b = openPlan(pathB, seed5());

  // a：一次推进到位，确认按某顺序到达。
  a.advanceTo(1_299_200);
  a.confirm("pay-a", 1_295_000, 700);
  a.confirm("pay-late", 1_260_000, 1000);

  // b：逐步推进（多次逾期扫描），确认按相反顺序到达。
  b.advanceTo(1_269_200);
  b.advanceTo(1_279_200);
  b.advanceTo(1_289_200);
  b.confirm("pay-late", 1_260_000, 1000);
  b.advanceTo(1_299_200);
  b.confirm("pay-a", 1_295_000, 700);
  b.advanceTo(1_299_200); // 相同时刻重复推进

  assert.deepEqual(a.inspect(), b.inspect());
  a.close();
  b.close();
});

test("同 ID 同内容重复确认幂等；同 ID 不同内容报错", () => {
  const plan = openPlan(tmpPath(), seed5());
  plan.advanceTo(START + 5000);
  plan.confirm("dup", START + 100, 300);
  plan.confirm("dup", START + 100, 300); // 幂等，不重复入账
  const snap = plan.inspect();
  assert.equal(snap.allocations.length, 1);
  assert.deepEqual(principals(snap), [700, 1000, 1000, 1000, 1000]);
  assert.throws(() => plan.confirm("dup", START + 100, 301), /different content/);
  plan.close();
});

test("校验：paidAt 越界、非正金额、观察时刻回退", () => {
  const plan = openPlan(tmpPath(), seed5());
  assert.throws(() => plan.confirm("x", START - 1, 100), /paidAt/);
  assert.throws(() => plan.confirm("x", START + 1, 0), /positive/);
  assert.throws(() => plan.confirm("x", START + 1, -5), /positive/);
  plan.advanceTo(START + 100);
  assert.throws(() => plan.advanceTo(START + 99), /monotonically/);
  plan.advanceTo(START + 100); // 相同时刻可重复
  plan.close();
});

test("重开计划使用已保存数据", () => {
  const path = tmpPath();
  const plan = openPlan(path, seed5());
  plan.advanceTo(1_269_200);
  plan.confirm("keep", 1_260_000, 400);
  plan.close();

  const reopened = openPlan(path); // 无 seed，重开
  const snap = reopened.inspect();
  // keep@1_260_000 抵期0本金400；T_0 检查时本金 600>0 → 计提 500。
  assert.deepEqual(principals(snap), [600, 1000, 1000, 1000, 1000]);
  assert.deepEqual(fees(snap), [500, 0, 0, 0, 0]);
  assert.equal(snap.now, 1_269_200);
  reopened.close();
});

test("同刻多笔到账按 requestId 字典序归账", () => {
  const plan = openPlan(tmpPath(), {
    startAt: START,
    installments: [
      { principal: 1000, dueAt: START + 10_000 },
      { principal: 1000, dueAt: START + 20_000 },
    ],
  });
  const T0 = START + 10_000 + FEE_DELAY;
  plan.advanceTo(T0 + 1); // T0 时刻期0 计提 500
  // 同刻两笔（费用检查之后），插入顺序与字典序相反：先插 "b"，再插 "a"。
  plan.confirm("b", T0 + 1, 800);
  plan.confirm("a", T0 + 1, 600);
  const snap = plan.inspect();
  // "a" 先处理：抵期0费用 500 + 期0本金 100；"b" 抵期0本金 800。
  assert.deepEqual(snap.allocations, [
    { requestId: "a", paidAt: T0 + 1, amount: 600, toPrincipal: 100, toFee: 500, unallocated: 0 },
    { requestId: "b", paidAt: T0 + 1, amount: 800, toPrincipal: 800, toFee: 0, unallocated: 0 },
  ]);
  assert.deepEqual(principals(snap), [100, 1000]);
  assert.deepEqual(fees(snap), [0, 0]);
  plan.close();
});
