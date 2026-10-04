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

function runToCompletion(api: CommissionSettlement, month: string): void {
  for (;;) {
    const info = api.advanceSettlement(month);
    if (info.status === "completed") {
      return;
    }
  }
}

test("12-level chain: exact rates per depth, self PV not counted", () => {
  const dbPath = tempDbPath();
  try {
    const api = new CommissionSettlement(dbPath);
    // chain: m0 <- m1 <- ... <- m12 (m1 sponsored by m0, etc.)
    const members: MemberInput[] = [];
    for (let i = 0; i <= 12; i += 1) {
      members.push({ id: `m${i}`, sponsor: i === 0 ? null : `m${i - 1}` });
    }
    for (const m of members) {
      api.upsertMember(m.id, m.sponsor);
    }
    // PV on the deepest member only: touches depths 1..12 exactly.
    api.setMonthlyPv("m12", MONTH, 1000);

    api.initiateSettlement(MONTH);
    runToCompletion(api, MONTH);

    // m0 is 12 edges above m12 (1%), m11 is 1 edge above (5%).
    const expectedPerDepth = [1000, 1000, 1000, 1000, 1000, 1000, 1000, 2000, 2000, 2000, 3000, 5000, 0];
    for (let i = 0; i <= 12; i += 1) {
      const r = api.getMemberResult(MONTH, `m${i}`);
      assert.ok(r, `result for m${i}`);
      assert.equal(r.commissionCents, expectedPerDepth[i], `m${i} commission`);
    }
    // m12's own PV earns nothing for itself beyond depth 12 ancestors.
    const deepest = api.getMemberResult(MONTH, "m12");
    assert.ok(deepest);
    assert.equal(deepest.commissionCents, 0);
    api.close();
  } finally {
    cleanupDb(dbPath);
  }
});

test("review flag: strictly above $2500 only, flag does not truncate", () => {
  const dbPath = tempDbPath();
  try {
    const api = new CommissionSettlement(dbPath);
    api.upsertMember("boss", null);
    api.upsertMember("exact", "boss");
    api.upsertMember("over", "boss");
    api.upsertMember("under", "boss");
    // direct downline rate 5%: 50000 PV -> exactly $2500.00
    api.setMonthlyPv("exact", MONTH, 50000);
    // 50001 PV -> $2500.05 -> flagged
    api.setMonthlyPv("over", MONTH, 50001);
    // 49999 PV -> $2499.95 -> not flagged
    api.setMonthlyPv("under", MONTH, 49999);

    api.initiateSettlement(MONTH);
    runToCompletion(api, MONTH);

    const boss = api.getMemberResult(MONTH, "boss")!;
    assert.equal(boss.commissionCents, 250000 + 250005 + 249995);
    assert.equal(boss.needsReview, true);

    // Each downline has no downlines of their own: zero commission rows exist.
    for (const id of ["exact", "over", "under"]) {
      const r = api.getMemberResult(MONTH, id)!;
      assert.ok(r, `row exists for ${id}`);
      assert.equal(r.commissionCents, 0);
      assert.equal(r.needsReview, false);
    }
    api.close();
  } finally {
    cleanupDb(dbPath);
  }
});

test("review flag boundary at exactly $2500 for a single member", () => {
  const dbPath = tempDbPath();
  try {
    const api = new CommissionSettlement(dbPath);
    api.upsertMember("a", null);
    api.upsertMember("b", "a");
    api.setMonthlyPv("b", MONTH, 50000); // exactly $2500 at 5%
    api.initiateSettlement(MONTH);
    runToCompletion(api, MONTH);
    const r = api.getMemberResult(MONTH, "a")!;
    assert.equal(r.commissionCents, 250000);
    assert.equal(r.needsReview, false);
    api.close();
  } finally {
    cleanupDb(dbPath);
  }
});

test("matches independent reference on a random tree", () => {
  const dbPath = tempDbPath();
  try {
    const api = new CommissionSettlement(dbPath);
    const members: MemberInput[] = [];
    const pv = new Map<string, number>();
    let seed = 42;
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const count = 500;
    for (let i = 0; i < count; i += 1) {
      const sponsor =
        i === 0 ? null : members[Math.floor(rand() * i)].id;
      members.push({ id: `u${i}`, sponsor });
    }
    for (const m of members) {
      api.upsertMember(m.id, m.sponsor);
      if (rand() < 0.5) {
        const value = Math.floor(rand() * 100000);
        pv.set(m.id, value);
        api.setMonthlyPv(m.id, MONTH, value);
      }
    }
    api.initiateSettlement(MONTH);
    runToCompletion(api, MONTH);

    const expected = referenceCommissions(members, pv);
    const all = api.getAllResults(MONTH)!;
    assert.equal(all.length, count);
    for (const r of all) {
      assert.equal(r.commissionCents, expected.get(r.memberId), r.memberId);
      assert.equal(r.needsReview, r.commissionCents > 250000, r.memberId);
    }
    api.close();
  } finally {
    cleanupDb(dbPath);
  }
});
