import { test } from "node:test";
import assert from "node:assert/strict";
import { CommissionSettlement } from "../src/index";
import {
  cleanupDb,
  referenceCommissions,
  tempDbPath,
  MemberInput,
} from "./helpers";

const MONTH = "2026-09";

function buildTree(api: CommissionSettlement, members: MemberInput[]): void {
  for (const m of members) {
    api.upsertMember(m.id, m.sponsor);
  }
}

test("inputs frozen at initiate: later edits + restart do not change the batch", () => {
  const dbPath = tempDbPath();
  try {
    // Snapshot A: two chains.
    const membersA: MemberInput[] = [
      { id: "root", sponsor: null },
      { id: "a1", sponsor: "root" },
      { id: "a2", sponsor: "a1" },
      { id: "b1", sponsor: "root" },
    ];
    const pvA = new Map<string, number>([
      ["a1", 1000],
      ["a2", 2000],
      ["b1", 3000],
    ]);

    let api = new CommissionSettlement(dbPath);
    buildTree(api, membersA);
    for (const [id, v] of pvA) {
      api.setMonthlyPv(id, MONTH, v);
    }

    const batch = api.initiateSettlement(MONTH);
    assert.equal(batch.status, "processing");
    assert.equal(batch.totalCount, 4);

    // Partial progress: exactly one member per advance call.
    const s1 = api.advanceSettlement(MONTH, 1);
    assert.equal(s1.doneCount, 1);

    // Mutate live inputs after the batch was accepted.
    api.upsertMember("a2", "b1"); // re-parent
    api.upsertMember("newbie", "root"); // new member
    api.setMonthlyPv("a1", MONTH, 99999); // overwrite PV
    api.setMonthlyPv("newbie", MONTH, 5000);

    // Simulate program exit and next-day recovery.
    api.close();
    api = new CommissionSettlement(dbPath);

    const resumed = api.getSettlementStatus(MONTH);
    assert.ok(resumed);
    assert.equal(resumed.batchId, batch.batchId);
    assert.equal(resumed.doneCount, 1, "persisted progress must not regress");
    assert.equal(resumed.totalCount, 4, "frozen member set excludes newbie");

    // While processing, no commission data is readable.
    assert.equal(api.getMemberResult(MONTH, "root"), null);
    assert.equal(api.getAllResults(MONTH), null);

    let info = resumed;
    while (info.status !== "completed") {
      info = api.advanceSettlement(MONTH, 2);
    }
    assert.equal(info.doneCount, 4);

    // Final results must match snapshot A exactly.
    const expected = referenceCommissions(membersA, pvA);
    const all = api.getAllResults(MONTH)!;
    assert.equal(all.length, 4);
    for (const r of all) {
      assert.equal(r.commissionCents, expected.get(r.memberId), r.memberId);
    }
    assert.equal(api.getMemberResult(MONTH, "newbie"), null);

    // Results stay published and immutable across another restart.
    api.close();
    api = new CommissionSettlement(dbPath);
    const again = api.getAllResults(MONTH)!;
    assert.deepEqual(again, all);
    api.close();
  } finally {
    cleanupDb(dbPath);
  }
});

test("duplicate initiate returns the original batch, even after completion", () => {
  const dbPath = tempDbPath();
  try {
    const api = new CommissionSettlement(dbPath);
    api.upsertMember("x", null);
    api.upsertMember("y", "x");
    api.setMonthlyPv("y", MONTH, 100);

    const first = api.initiateSettlement(MONTH);
    // Simulate lost response: caller retries and must get the same batch.
    const retry = api.initiateSettlement(MONTH);
    assert.equal(retry.batchId, first.batchId);
    assert.equal(retry.totalCount, 2);

    api.advanceSettlement(MONTH);
    const done = api.advanceSettlement(MONTH);
    assert.equal(done.status, "completed");

    // Inputs changed after completion: re-initiate still returns the old batch.
    api.upsertMember("z", "x");
    api.setMonthlyPv("z", MONTH, 7777);
    const afterDone = api.initiateSettlement(MONTH);
    assert.equal(afterDone.batchId, first.batchId);
    assert.equal(afterDone.status, "completed");
    assert.equal(afterDone.totalCount, 2);

    const x = api.getMemberResult(MONTH, "x")!;
    assert.equal(x.commissionCents, 500); // 100 PV * 5 cents, unchanged
    api.close();
  } finally {
    cleanupDb(dbPath);
  }
});

test("advance retries never double-count and never regress", () => {
  const dbPath = tempDbPath();
  try {
    let api = new CommissionSettlement(dbPath);
    const members: MemberInput[] = [];
    const pv = new Map<string, number>();
    for (let i = 0; i < 50; i += 1) {
      members.push({ id: `m${i}`, sponsor: i === 0 ? null : `m${i - 1}` });
    }
    for (const m of members) {
      api.upsertMember(m.id, m.sponsor);
      api.setMonthlyPv(m.id, MONTH, 100);
      pv.set(m.id, 100);
    }
    api.initiateSettlement(MONTH);

    // Advance with restarts between every step; re-attempt the same step
    // (simulating a lost response) before moving on.
    let done = 0;
    while (done < 50) {
      const step = api.advanceSettlement(MONTH, 7);
      const afterStep = api.getSettlementStatus(MONTH)!;
      assert.ok(afterStep.doneCount >= done, "no regression");
      done = afterStep.doneCount;
      api.close();
      api = new CommissionSettlement(dbPath);
      const afterRestart = api.getSettlementStatus(MONTH)!;
      assert.equal(afterRestart.doneCount, done, "restart keeps progress");
      assert.ok(step.doneCount <= done);
    }

    const expected = referenceCommissions(members, pv);
    const all = api.getAllResults(MONTH)!;
    assert.equal(all.length, 50);
    for (const r of all) {
      assert.equal(r.commissionCents, expected.get(r.memberId), r.memberId);
    }
    api.close();
  } finally {
    cleanupDb(dbPath);
  }
});

test("advance clamps to 200 members per call", () => {
  const dbPath = tempDbPath();
  try {
    const api = new CommissionSettlement(dbPath);
    for (let i = 0; i < 500; i += 1) {
      api.upsertMember(`u${i}`, null);
    }
    api.initiateSettlement(MONTH);
    const info = api.advanceSettlement(MONTH, 100000);
    assert.equal(info.doneCount, 200);
    assert.equal(info.status, "processing");
    assert.equal(api.getAllResults(MONTH), null);
    api.close();
  } finally {
    cleanupDb(dbPath);
  }
});

test("status of unknown month is null; advance without batch throws", () => {
  const dbPath = tempDbPath();
  try {
    const api = new CommissionSettlement(dbPath);
    assert.equal(api.getSettlementStatus(MONTH), null);
    assert.throws(() => api.advanceSettlement(MONTH));
    api.close();
  } finally {
    cleanupDb(dbPath);
  }
});
