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
const TOTAL = 100000;
const CHAIN = 1000;

test("scale: 100k members, 12-level chain, restart mid-settlement", { timeout: 300000 }, () => {
  const dbPath = tempDbPath();
  try {
    let api = new CommissionSettlement(dbPath);
    const members: MemberInput[] = [];
    const pv = new Map<string, number>();

    // 10-ary tree over u0..u{TOTAL-1}: depth ~6, broad fan-out.
    for (let i = 0; i < TOTAL; i += 1) {
      const sponsor = i === 0 ? null : `u${Math.floor((i - 1) / 10)}`;
      members.push({ id: `u${i}`, sponsor });
    }
    // A 1000-deep chain hanging off u0 exercises the 12-level cutoff.
    for (let i = 0; i < CHAIN; i += 1) {
      members.push({ id: `c${i}`, sponsor: i === 0 ? "u0" : `c${i - 1}` });
    }
    for (const m of members) {
      api.upsertMember(m.id, m.sponsor);
    }
    // Deterministic pseudo-random PV on ~1/3 of members.
    let seed = 7;
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (const m of members) {
      if (rand() < 0.34) {
        const value = Math.floor(rand() * 100000);
        pv.set(m.id, value);
        api.setMonthlyPv(m.id, MONTH, value);
      }
    }

    const batch = api.initiateSettlement(MONTH);
    assert.equal(batch.totalCount, TOTAL + CHAIN);

    // Advance roughly halfway, then simulate a restart.
    let info = batch;
    let guard = 0;
    while (info.doneCount < Math.floor((TOTAL + CHAIN) / 2)) {
      info = api.advanceSettlement(MONTH);
      guard += 1;
      assert.ok(guard < 10000, "progress must keep moving");
      assert.equal(info.status, "processing");
      assert.equal(api.getAllResults(MONTH), null, "no partial results");
    }
    const doneBeforeRestart = info.doneCount;
    api.close();

    api = new CommissionSettlement(dbPath);
    const resumed = api.getSettlementStatus(MONTH)!;
    assert.equal(resumed.doneCount, doneBeforeRestart, "progress persists");
    assert.equal(resumed.batchId, batch.batchId);

    while (info.status !== "completed") {
      info = api.advanceSettlement(MONTH);
    }
    assert.equal(info.doneCount, TOTAL + CHAIN);

    const expected = referenceCommissions(members, pv);
    const all = api.getAllResults(MONTH)!;
    assert.equal(all.length, TOTAL + CHAIN);
    let checked = 0;
    for (const r of all) {
      const want = expected.get(r.memberId);
      if (r.commissionCents !== want) {
        assert.equal(r.commissionCents, want, r.memberId);
      }
      assert.equal(r.needsReview, r.commissionCents > 250000, r.memberId);
      checked += 1;
    }
    assert.equal(checked, TOTAL + CHAIN);

    // Spot-check single-member queries.
    const u0 = api.getMemberResult(MONTH, "u0")!;
    assert.equal(u0.commissionCents, expected.get("u0"));
    api.close();
  } finally {
    cleanupDb(dbPath);
  }
});
