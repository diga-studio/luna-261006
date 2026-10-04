import { test } from "node:test";
import { strict as assert } from "node:assert";
import { openPlan } from "../src/plan.js";
import { tempDbPath, cleanupAll } from "./helpers.js";

const S = 1_000_000;
const GRACE = 259200;
// 5 期，每期本金 1000，dueAt 间隔 1000 秒
const seed = {
  startAt: S,
  installments: [1, 2, 3, 4, 5].map((i) => ({
    principal: 1000,
    dueAt: S + 1000 * i,
  })),
};
// 费用检查时刻：check_i = S + 1000*(i+1) + 259200
const NOW = S + 263200; // check_0..check_3 均已到达，check_4 未到达

test("费用封顶后晚到确认使名额转移到第四个符合条件的期次，并改写已有分配", () => {
  const plan = openPlan(tempDbPath(), seed);

  plan.advanceTo(NOW);
  const before = plan.inspect();
  // 手算：前三期各计提 500，达到 1500 上限；第 4 期（idx 3）因封顶未计提
  assert.deepEqual(
    before.installments.map((x) => x.feeOutstanding),
    [500, 500, 500, 0, 0],
  );
  assert.equal(before.totalFeesCharged, 1500);

  // 到账 600：先抵费用，期次从早到晚 → idx0 抵 500，idx1 抵 100
  plan.confirm("pay-a", NOW, 600);
  const afterPayA = plan.inspect();
  assert.deepEqual(
    afterPayA.installments.map((x) => x.feeOutstanding),
    [0, 400, 500, 0, 0],
  );
  assert.deepEqual(afterPayA.allocations, [
    {
      requestId: "pay-a",
      paidAt: NOW,
      amount: 600,
      feesPaid: 600,
      principalPaid: 0,
      unallocated: 0,
    },
  ]);

  // 晚到确认：paidAt 在 check_0 之前，恰好清偿 idx0 本金
  plan.confirm("pay-late", S + 1000, 1000);
  const after = plan.inspect();

  // idx0 在费用检查前已清偿 → 费用被撤销；名额顺延给 idx3
  assert.deepEqual(
    after.installments.map((x) => x.feeCharged),
    [false, true, true, true, false],
  );
  assert.equal(after.totalFeesCharged, 1500);
  // pay-a 的 600 重新分配：idx1 抵 500，idx2 抵 100
  assert.deepEqual(
    after.installments.map((x) => x.feeOutstanding),
    [0, 0, 400, 500, 0],
  );
  // 本金：idx0 被 pay-late 清偿，其余未动
  assert.deepEqual(
    after.installments.map((x) => x.principalOutstanding),
    [0, 1000, 1000, 1000, 1000],
  );
  // 逐笔去向：按 (paidAt, requestId) 排序
  assert.deepEqual(after.allocations, [
    {
      requestId: "pay-late",
      paidAt: S + 1000,
      amount: 1000,
      feesPaid: 0,
      principalPaid: 1000,
      unallocated: 0,
    },
    {
      requestId: "pay-a",
      paidAt: NOW,
      amount: 600,
      feesPaid: 600,
      principalPaid: 0,
      unallocated: 0,
    },
  ]);
  assert.equal(after.unallocated, 0);
  plan.close();
  cleanupAll();
});
