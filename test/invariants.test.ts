import { test } from "node:test";
import { strict as assert } from "node:assert";
import { openPlan } from "../src/plan.js";
import { tempDbPath, cleanupAll } from "./helpers.js";
import type { PlanSnapshot } from "../src/types.js";

const S = 1_000_000;
const GRACE = 259200;

const seed = {
  startAt: S,
  installments: [1, 2, 3, 4].map((i) => ({ principal: 700, dueAt: S + 1000 * i })),
};

const CONFIRMATIONS: [string, number, number][] = [
  ["c-1", S + 500, 300],
  ["c-2", S + 1500, 900],
  ["c-3", S + 2500, 400],
  ["c-4", S + 100, 700], // 晚到：清偿 idx0 本金，撤销其费用
];
const NOW = S + 4000 + GRACE; // 全部费用检查时刻均已到达

function assertInvariants(snap: PlanSnapshot): void {
  for (const a of snap.allocations) {
    assert.equal(a.amount, a.feesPaid + a.principalPaid + a.unallocated, a.requestId);
  }
  for (const inst of snap.installments) {
    assert.ok(inst.principalOutstanding >= 0);
    assert.ok(inst.feeOutstanding >= 0);
  }
  assert.ok(snap.unallocated >= 0);
  assert.ok(snap.totalFeesCharged <= 1500);
}

test("归账结果与确认接收顺序无关", () => {
  const planA = openPlan(tempDbPath(), seed);
  const planB = openPlan(tempDbPath(), seed);
  for (const [id, paidAt, amount] of CONFIRMATIONS) {
    planA.advanceTo(Math.max(paidAt, planA.inspect().now));
    planA.confirm(id, paidAt, amount);
  }
  for (const [id, paidAt, amount] of [...CONFIRMATIONS].reverse()) {
    planB.advanceTo(Math.max(paidAt, planB.inspect().now));
    planB.confirm(id, paidAt, amount);
  }
  planA.advanceTo(NOW);
  planB.advanceTo(NOW);
  const snapA = planA.inspect();
  const snapB = planB.inspect();
  assert.deepEqual(snapA, snapB);
  assertInvariants(snapA);
  // 手算锚点：c-4 清偿 idx0，c-1..c-3 依次清偿 idx1、idx2 并部分抵 idx3
  // → 仅 idx3 在检查时仍有本金 500，计提 500
  assert.deepEqual(
    snapA.installments.map((x) => x.feeCharged),
    [false, false, false, true],
  );
  assert.equal(snapA.totalFeesCharged, 500);
  planA.close();
  planB.close();
  cleanupAll();
});

test("一次跨过多个期限的推进等同于逐个期限推进，且相同时刻可重复推进", () => {
  const planJump = openPlan(tempDbPath(), seed);
  const planStep = openPlan(tempDbPath(), seed);
  planJump.advanceTo(NOW);
  planJump.advanceTo(NOW); // 相同时刻重复调用
  for (let t = S; t <= NOW; t += 997) {
    planStep.advanceTo(t);
  }
  planStep.advanceTo(NOW);
  const snapJump = planJump.inspect();
  assert.deepEqual(snapJump, planStep.inspect());
  // 手算锚点：无到账，四期各计提 500 但受 1500 封顶 → 前三期有费用
  assert.deepEqual(
    snapJump.installments.map((x) => x.feeOutstanding),
    [500, 500, 500, 0],
  );
  assert.equal(snapJump.totalFeesCharged, 1500);
  planJump.close();
  planStep.close();
  cleanupAll();
});

test("同 ID 同内容重复确认不重复入账，内容冲突则抛错", () => {
  const plan = openPlan(tempDbPath(), seed);
  plan.advanceTo(S + 500);
  plan.confirm("dup", S + 500, 300);
  plan.confirm("dup", S + 500, 300);
  const snap = plan.inspect();
  assert.equal(snap.allocations.length, 1);
  assert.equal(snap.installments[0].principalOutstanding, 400);
  assert.throws(() => plan.confirm("dup", S + 500, 301), /different content/);
  assert.throws(() => plan.advanceTo(S + 499), /monotonic/);
  plan.close();
  cleanupAll();
});

test("关闭后重开使用已保存数据，可继续推进与确认", () => {
  const path = tempDbPath();
  const plan = openPlan(path, seed);
  plan.advanceTo(S + 500);
  plan.confirm("c-1", S + 500, 300);
  plan.close();

  const reopened = openPlan(path); // 无需 seed
  const snap = reopened.inspect();
  assert.equal(snap.now, S + 500);
  assert.equal(snap.installments[0].principalOutstanding, 400);
  reopened.advanceTo(NOW);
  const final = reopened.inspect();
  assertInvariants(final);
  // 手算锚点：idx0 余 400 本金 → 四期检查均触发但封顶 1500 → 前三期各 500
  assert.deepEqual(
    final.installments.map((x) => x.feeOutstanding),
    [500, 500, 500, 0],
  );
  reopened.close();
  cleanupAll();
});
