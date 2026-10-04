import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Ledger } from "../src/index.ts";
import type { Snapshot } from "../src/index.ts";

function makeLedger(): Ledger {
  return new Ledger({
    accounts: [
      { id: "alice", available: 100 },
      { id: "bob", available: 0 },
      { id: "carol", available: 50 },
    ],
    projects: [
      { id: "p1", clientId: "alice", creatorId: "bob" },
      { id: "p2", clientId: "carol", creatorId: "bob" },
    ],
  });
}

/** 从流水独立重放：不读账本状态表，仅由 flows 复算各资金归属。 */
function replayFlows(snapshot: Snapshot): {
  available: Map<string, number>;
  earnings: Map<string, number>;
  escrow: Map<string, number>;
  total: number;
} {
  const available = new Map<string, number>();
  const earnings = new Map<string, number>();
  const escrow = new Map<string, number>();
  const credit = (map: Map<string, number>, id: string, amount: number): void => {
    map.set(id, (map.get(id) ?? 0) + amount);
  };
  const debit = (map: Map<string, number>, id: string, amount: number): void => {
    const next = (map.get(id) ?? 0) - amount;
    assert.ok(next >= 0, `replay: negative balance for ${id}`);
    map.set(id, next);
  };
  const route = new Map<string, Map<string, number>>([
    ["escrow:", escrow],
    ["earnings:", earnings],
  ]);
  const mapFor = (account: string): Map<string, number> => {
    for (const [prefix, map] of route) {
      if (account.startsWith(prefix)) return map;
    }
    return available;
  };
  let total = 0;
  for (const flow of snapshot.flows) {
    if (flow.from === "external") {
      total += flow.amount;
    } else {
      debit(mapFor(flow.from), flow.from, flow.amount);
    }
    credit(mapFor(flow.to), flow.to, flow.amount);
  }
  return { available, earnings, escrow, total };
}

function assertSnapshotConsistent(snapshot: Snapshot, initialTotal: number): void {
  const replayed = replayFlows(snapshot);
  let sum = 0;
  for (const account of snapshot.accounts) {
    assert.ok(account.available >= 0 && account.earnings >= 0);
    assert.equal(replayed.available.get(account.id) ?? 0, account.available);
    assert.equal(replayed.earnings.get(`earnings:${account.id}`) ?? 0, account.earnings);
    sum += account.available + account.earnings;
  }
  for (const milestone of snapshot.milestones) {
    assert.ok(milestone.amount >= 0);
    if (milestone.status === "pending") {
      const pot = replayed.escrow.get(`escrow:${milestone.projectId}:${milestone.id}`) ?? 0;
      assert.equal(pot, milestone.amount);
      sum += pot;
    } else {
      const pot = replayed.escrow.get(`escrow:${milestone.projectId}:${milestone.id}`) ?? 0;
      assert.equal(pot, 0);
    }
  }
  assert.equal(sum, initialTotal);
  assert.equal(replayed.total, initialTotal);
}

test("同一客户两笔冻结，余额只够一笔时只有一笔成功", () => {
  const ledger = makeLedger();
  const first = ledger.reserve("p1", "m1", 60, "k1");
  const second = ledger.reserve("p1", "m2", 60, "k2");
  assert.deepEqual(first, { ok: true, value: { projectId: "p1", milestoneId: "m1", amount: 60 } });
  assert.deepEqual(second, { ok: false, error: "INSUFFICIENT_FUNDS" });

  // 失败调用不占用 key：调低金额后同一 key 可成功。
  const retried = ledger.reserve("p1", "m2", 40, "k2");
  assert.equal(retried.ok, true);

  // 余额不足时账本不变更：流水只有 init 与成功的那笔冻结。
  const snapshot = ledger.snapshot();
  assert.equal(snapshot.flows.filter((f) => f.op === "reserve").length, 2);
  assert.equal(snapshot.accounts.find((a) => a.id === "alice")?.available, 0);
  assertSnapshotConsistent(snapshot, 150);
  ledger.close();
});

test("部分裁决后取消项目：退回未裁决冻结额，重放流水核对归属", () => {
  const ledger = makeLedger();
  assert.equal(ledger.reserve("p1", "m1", 40, "k1").ok, true);
  assert.equal(ledger.reserve("p1", "m2", 30, "k2").ok, true);
  assert.equal(ledger.reserve("p1", "m3", 20, "k3").ok, true);

  // m1 部分支付给创作者。
  const resolved = ledger.resolve("p1", "m1", 15, "k4");
  assert.deepEqual(resolved, {
    ok: true,
    value: { projectId: "p1", milestoneId: "m1", award: 15, refunded: 25 },
  });

  // 取消项目：只退 m2、m3，已裁决的 m1 不追溯。
  const cancelled = ledger.cancel("p1", "k5");
  assert.deepEqual(cancelled, {
    ok: true,
    value: { projectId: "p1", refunded: 50, refundedMilestones: ["m2", "m3"] },
  });
  const flowCountAfterCancel = ledger.snapshot().flows.length;

  // 重试先前成功请求：返回原结果，不新增流水。
  assert.deepEqual(ledger.reserve("p1", "m1", 40, "k1"), {
    ok: true,
    value: { projectId: "p1", milestoneId: "m1", amount: 40 },
  });
  assert.deepEqual(ledger.resolve("p1", "m1", 15, "k4"), resolved);
  assert.deepEqual(ledger.cancel("p1", "k5"), cancelled);
  assert.equal(ledger.snapshot().flows.length, flowCountAfterCancel);

  // 取消后的限制。
  assert.deepEqual(ledger.reserve("p1", "m4", 1, "k6"), { ok: false, error: "PROJECT_CANCELLED" });
  assert.deepEqual(ledger.cancel("p1", "k7"), { ok: false, error: "ALREADY_CANCELLED" });
  assert.deepEqual(ledger.resolve("p1", "m2", 5, "k8"), { ok: false, error: "MILESTONE_ENDED" });

  // 已结束的里程碑标识不能复用（含已退款与已裁决）。
  assert.deepEqual(ledger.reserve("p1", "m1", 1, "k9"), { ok: false, error: "PROJECT_CANCELLED" });

  // 资金归属：alice = 100 - 15（付给 bob），bob 收益 15。
  const snapshot = ledger.snapshot();
  assert.equal(snapshot.accounts.find((a) => a.id === "alice")?.available, 85);
  assert.equal(snapshot.accounts.find((a) => a.id === "bob")?.earnings, 15);
  assert.equal(snapshot.projects.find((p) => p.id === "p1")?.status, "cancelled");
  assert.equal(snapshot.milestones.find((m) => m.id === "m1")?.status, "resolved");
  assert.equal(snapshot.milestones.find((m) => m.id === "m2")?.status, "refunded");
  assertSnapshotConsistent(snapshot, 150);
  ledger.close();
});

test("key 在账本内唯一并绑定操作与参数", () => {
  const ledger = makeLedger();
  assert.equal(ledger.reserve("p1", "m1", 10, "dup").ok, true);
  // 同键不同参数（金额、里程碑、操作、项目）均拒绝。
  assert.deepEqual(ledger.reserve("p1", "m1", 11, "dup"), { ok: false, error: "KEY_CONFLICT" });
  assert.deepEqual(ledger.reserve("p1", "m2", 10, "dup"), { ok: false, error: "KEY_CONFLICT" });
  assert.deepEqual(ledger.resolve("p1", "m1", 10, "dup"), { ok: false, error: "KEY_CONFLICT" });
  assert.deepEqual(ledger.cancel("p1", "dup"), { ok: false, error: "KEY_CONFLICT" });
  // 不同项目的操作也不能撞 key。
  assert.deepEqual(ledger.reserve("p2", "m1", 10, "dup"), { ok: false, error: "KEY_CONFLICT" });
  ledger.close();
});

test("裁决金额边界：0 与全部冻结额", () => {
  const ledger = makeLedger();
  ledger.reserve("p1", "m1", 30, "k1");
  ledger.reserve("p1", "m2", 30, "k2");
  assert.deepEqual(ledger.resolve("p1", "m1", 0, "k3"), {
    ok: true,
    value: { projectId: "p1", milestoneId: "m1", award: 0, refunded: 30 },
  });
  assert.deepEqual(ledger.resolve("p1", "m2", 30, "k4"), {
    ok: true,
    value: { projectId: "p1", milestoneId: "m2", award: 30, refunded: 0 },
  });
  assert.deepEqual(ledger.resolve("p1", "m1", 1, "k5"), { ok: false, error: "MILESTONE_ENDED" });
  // 已裁决里程碑标识不能复用。
  assert.deepEqual(ledger.reserve("p1", "m1", 1, "k6"), { ok: false, error: "MILESTONE_EXISTS" });
  const snapshot = ledger.snapshot();
  assert.equal(snapshot.accounts.find((a) => a.id === "alice")?.available, 70);
  assert.equal(snapshot.accounts.find((a) => a.id === "bob")?.earnings, 30);
  assertSnapshotConsistent(snapshot, 150);
  ledger.close();
});

test("非法金额与未知项目/里程碑不改变账本", () => {
  const ledger = makeLedger();
  const flowsBefore = ledger.snapshot().flows.length;
  assert.deepEqual(ledger.reserve("p1", "m1", 0, "k1"), { ok: false, error: "INVALID_AMOUNT" });
  assert.deepEqual(ledger.reserve("p1", "m1", -5, "k2"), { ok: false, error: "INVALID_AMOUNT" });
  assert.deepEqual(ledger.reserve("p1", "m1", 1.5, "k3"), { ok: false, error: "INVALID_AMOUNT" });
  assert.deepEqual(ledger.reserve("nope", "m1", 1, "k4"), { ok: false, error: "PROJECT_NOT_FOUND" });
  assert.deepEqual(ledger.resolve("p1", "nope", 1, "k5"), { ok: false, error: "MILESTONE_NOT_FOUND" });
  assert.deepEqual(ledger.cancel("nope", "k6"), { ok: false, error: "PROJECT_NOT_FOUND" });
  assert.equal(ledger.snapshot().flows.length, flowsBefore);
  assertSnapshotConsistent(ledger.snapshot(), 150);
  ledger.close();
});

test("流水只追加且可独立重放复算当前账目", () => {
  const ledger = makeLedger();
  ledger.reserve("p1", "m1", 40, "k1");
  ledger.reserve("p2", "m1", 50, "k2");
  ledger.resolve("p1", "m1", 10, "k3");
  ledger.cancel("p2", "k4");
  const snapshot = ledger.snapshot();
  const seqs = snapshot.flows.map((f) => f.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  assertSnapshotConsistent(snapshot, 150);
  // carol 全额退回，alice 付出 10，bob 收益 10。
  assert.equal(snapshot.accounts.find((a) => a.id === "carol")?.available, 50);
  assert.equal(snapshot.accounts.find((a) => a.id === "alice")?.available, 90);
  assert.equal(snapshot.accounts.find((a) => a.id === "bob")?.earnings, 10);
  ledger.close();
});

test("SQLite 文件持久化：数据落盘且可重新打开", () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-"));
  const path = join(dir, "ledger.db");
  const ledger = new Ledger({
    path,
    accounts: [{ id: "alice", available: 100 }, { id: "bob", available: 0 }],
    projects: [{ id: "p1", clientId: "alice", creatorId: "bob" }],
  });
  ledger.reserve("p1", "m1", 40, "k1");
  ledger.resolve("p1", "m1", 10, "k2");
  ledger.close();

  const reopened = new DatabaseSync(path);
  const row = reopened
    .prepare("SELECT available, earnings FROM accounts WHERE id = 'bob'")
    .get() as { available: number; earnings: number };
  assert.equal(row.earnings, 10);
  reopened.close();
  rmSync(dir, { recursive: true, force: true });
});
