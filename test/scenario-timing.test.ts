import { test } from "node:test";
import { strict as assert } from "node:assert";
import { openPlan } from "../src/plan.js";
import { tempDbPath, cleanupAll } from "./helpers.js";

const S = 1_000_000;
const GRACE = 259200;

test("先推进到计费时刻，再补入恰好该时刻的到账：费用被撤销", () => {
  const dueAt = S + 5000;
  const checkAt = dueAt + GRACE;
  const plan = openPlan(tempDbPath(), {
    startAt: S,
    installments: [{ principal: 800, dueAt }],
  });

  plan.advanceTo(checkAt);
  const charged = plan.inspect();
  assert.equal(charged.totalFeesCharged, 500);
  assert.equal(charged.installments[0].feeOutstanding, 500);

  // paidAt 恰好等于费用检查时刻：同一时刻先处理到账，本金已清偿 → 费用不发生
  plan.confirm("p", checkAt, 800);
  const after = plan.inspect();
  assert.equal(after.totalFeesCharged, 0);
  assert.deepEqual(
    after.installments.map((x) => [x.principalOutstanding, x.feeOutstanding, x.feeCharged]),
    [[0, 0, false]],
  );
  assert.deepEqual(after.allocations, [
    {
      requestId: "p",
      paidAt: checkAt,
      amount: 800,
      feesPaid: 0,
      principalPaid: 800,
      unallocated: 0,
    },
  ]);
  assert.equal(after.unallocated, 0);
  plan.close();
  cleanupAll();
});

test("提前结清后的超付留存为未分配余额，且不被动抵扣后续费用", () => {
  const plan = openPlan(tempDbPath(), {
    startAt: S,
    installments: [
      { principal: 500, dueAt: S + 1000 },
      { principal: 500, dueAt: S + 2000 },
    ],
  });

  // 提前结清全部本金并超付 200
  plan.advanceTo(S + 100);
  plan.confirm("early", S + 100, 1200);
  const paid = plan.inspect();
  assert.deepEqual(paid.allocations, [
    {
      requestId: "early",
      paidAt: S + 100,
      amount: 1200,
      feesPaid: 0,
      principalPaid: 1000,
      unallocated: 200,
    },
  ]);
  assert.equal(paid.unallocated, 200);

  // 跨过全部费用检查时刻：本金早已清偿，不产生任何费用
  plan.advanceTo(S + 2000 + GRACE);
  const settled = plan.inspect();
  assert.equal(settled.totalFeesCharged, 0);
  assert.deepEqual(
    settled.installments.map((x) => [x.principalOutstanding, x.feeOutstanding]),
    [
      [0, 0],
      [0, 0],
    ],
  );
  assert.equal(settled.unallocated, 200);
  plan.close();
  cleanupAll();
});
