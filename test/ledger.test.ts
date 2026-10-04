import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import { Ledger, replay, type LedgerInit, type Snapshot } from "../src/index.js";

function makeInit(clientAvailable: number): LedgerInit {
  return {
    accounts: [
      { accountId: "client", available: clientAvailable },
      { accountId: "creator", available: 0 },
    ],
    projects: [{ projectId: "p1", clientId: "client", creatorId: "creator" }],
  };
}

function assertInvariant(snapshot: Snapshot): void {
  let total = 0;
  for (const account of snapshot.accounts) {
    assert.ok(account.available >= 0, "available 非负");
    assert.ok(account.earnings >= 0, "earnings 非负");
    total += account.available + account.earnings;
  }
  for (const milestone of snapshot.milestones) {
    assert.ok(milestone.amount >= 0, "冻结额非负");
    if (milestone.status === "frozen") total += milestone.amount;
  }
  assert.equal(total, snapshot.totalSupply, "总额守恒");
}

test("同一客户两笔冻结，余额只够一笔时只有一笔成功", () => {
  const ledger = new Ledger(makeInit(100));
  const first = ledger.reserve("p1", "m1", 60, "k1");
  const second = ledger.reserve("p1", "m2", 60, "k2");
  assert.deepEqual(first, {
    ok: true,
    value: { projectId: "p1", milestoneId: "m1", amount: 60 },
  });
  assert.deepEqual(second, { ok: false, reason: "insufficient_funds" });

  // 失败调用不占用 key：换用更小金额后同一 key 可以成功。
  const retry = ledger.reserve("p1", "m2", 40, "k2");
  assert.deepEqual(retry, {
    ok: true,
    value: { projectId: "p1", milestoneId: "m2", amount: 40 },
  });

  const snapshot = ledger.snapshot();
  assert.equal(snapshot.accounts.find((a) => a.accountId === "client")?.available, 0);
  assertInvariant(snapshot);
  assert.equal(replay(snapshot).ok, true);
  ledger.close();
});

test("部分支付后取消项目：退回未裁决冻结额，重放核对归属", () => {
  const ledger = new Ledger(makeInit(1000));
  assert.equal(ledger.reserve("p1", "m1", 400, "r1").ok, true);
  assert.equal(ledger.reserve("p1", "m2", 300, "r2").ok, true);
  assert.equal(ledger.reserve("p1", "m3", 200, "r3").ok, true);

  // m1 部分支付给创作者：award 150，退客户 250。
  const resolved = ledger.resolve("p1", "m1", 150, "s1");
  assert.deepEqual(resolved, {
    ok: true,
    value: { projectId: "p1", milestoneId: "m1", award: 150, refunded: 250 },
  });

  // 取消项目：m2、m3 的冻结额退回客户，已裁决的 m1 不追溯。
  const cancelled = ledger.cancel("p1", "c1");
  assert.deepEqual(cancelled, {
    ok: true,
    value: { projectId: "p1", refundedTotal: 500, refundedMilestones: ["m2", "m3"] },
  });

  const entriesBefore = ledger.snapshot().entries.length;

  // 重试先前成功的请求：返回原结果，不新增流水。
  assert.deepEqual(ledger.resolve("p1", "m1", 150, "s1"), resolved);
  assert.deepEqual(ledger.cancel("p1", "c1"), cancelled);
  assert.deepEqual(ledger.reserve("p1", "m2", 300, "r2"), {
    ok: true,
    value: { projectId: "p1", milestoneId: "m2", amount: 300 },
  });
  assert.equal(ledger.snapshot().entries.length, entriesBefore, "重试不新增流水");

  // 同 key 不同参数拒绝。
  assert.deepEqual(ledger.resolve("p1", "m1", 200, "s1"), {
    ok: false,
    reason: "duplicate_key_conflict",
  });

  // 取消后不能再冻结、不能再取消、已退款里程碑不能再裁决。
  assert.deepEqual(ledger.reserve("p1", "m4", 10, "r4"), {
    ok: false,
    reason: "project_cancelled",
  });
  assert.deepEqual(ledger.cancel("p1", "c2"), { ok: false, reason: "project_cancelled" });
  assert.deepEqual(ledger.resolve("p1", "m2", 100, "s2"), {
    ok: false,
    reason: "milestone_already_final",
  });

  // 资金归属：客户 1000-150=850，创作者收益 150。
  const snapshot = ledger.snapshot();
  const client = snapshot.accounts.find((a) => a.accountId === "client");
  const creator = snapshot.accounts.find((a) => a.accountId === "creator");
  assert.equal(client?.available, 850);
  assert.equal(creator?.available, 0);
  assert.equal(creator?.earnings, 150);
  assert.equal(
    snapshot.projects.find((p) => p.projectId === "p1")?.status,
    "cancelled",
  );

  // 独立重放流水：从初始余额复算，资金归属与余额一致。
  const report = replay(snapshot);
  assert.deepEqual(report.problems, []);
  assert.equal(report.ok, true);
  assert.equal(report.balances.get("account:client:available"), 850);
  assert.equal(report.balances.get("account:creator:earnings"), 150);
  assertInvariant(snapshot);
  ledger.close();
});

test("金额与归属校验", () => {
  const ledger = new Ledger(makeInit(100));
  assert.deepEqual(ledger.reserve("p1", "m1", 0, "k0"), {
    ok: false,
    reason: "invalid_amount",
  });
  assert.deepEqual(ledger.reserve("p1", "m1", -5, "k0"), {
    ok: false,
    reason: "invalid_amount",
  });
  assert.deepEqual(ledger.reserve("p1", "m1", 1.5, "k0"), {
    ok: false,
    reason: "invalid_amount",
  });
  assert.deepEqual(ledger.reserve("nope", "m1", 10, "k1"), {
    ok: false,
    reason: "unknown_project",
  });
  assert.equal(ledger.reserve("p1", "m1", 50, "k2").ok, true);
  assert.deepEqual(ledger.reserve("p1", "m1", 50, "k3"), {
    ok: false,
    reason: "milestone_exists",
  });
  // 已结束的里程碑标识不能复用。
  assert.equal(ledger.resolve("p1", "m1", 50, "k4").ok, true);
  assert.deepEqual(ledger.reserve("p1", "m1", 10, "k5"), {
    ok: false,
    reason: "milestone_exists",
  });
  // award 超出冻结额。
  assert.equal(ledger.reserve("p1", "m2", 20, "k6").ok, true);
  assert.deepEqual(ledger.resolve("p1", "m2", 21, "k7"), {
    ok: false,
    reason: "award_out_of_range",
  });
  // 失败不占用 key：修正 award 后同一 key 成功。
  assert.equal(ledger.resolve("p1", "m2", 20, "k7").ok, true);
  const snapshot = ledger.snapshot();
  assertInvariant(snapshot);
  assert.equal(replay(snapshot).ok, true);
  ledger.close();
});

test("文件库重开后账目与幂等键保持", () => {
  const path = `/tmp/ledger-test-${process.pid}.sqlite`;
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(path + suffix); } catch { /* 忽略不存在 */ }
  }
  const init = makeInit(100);
  const first = new Ledger(init, path);
  assert.equal(first.reserve("p1", "m1", 40, "k1").ok, true);
  first.close();

  const reopened = new Ledger(init, path);
  // 幂等键在重开后仍返回首次结果。
  assert.deepEqual(reopened.reserve("p1", "m1", 40, "k1"), {
    ok: true,
    value: { projectId: "p1", milestoneId: "m1", amount: 40 },
  });
  const snapshot = reopened.snapshot();
  assert.equal(snapshot.totalSupply, 100);
  assert.equal(snapshot.accounts.find((a) => a.accountId === "client")?.available, 60);
  assert.equal(replay(snapshot).ok, true);
  reopened.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(path + suffix); } catch { /* 忽略不存在 */ }
  }
});
