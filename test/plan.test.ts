import { test } from "node:test";
import { strict as assert } from "node:assert";
import { openPlan } from "../src/plan.js";
import { tempDbPath, cleanupAll } from "./helpers.js";

test("smoke: create plan and inspect empty state", () => {
  const plan = openPlan(tempDbPath(), {
    startAt: 1_000_000,
    installments: [
      { principal: 1000, dueAt: 1_001_000 },
      { principal: 1000, dueAt: 1_002_000 },
    ],
  });
  const snap = plan.inspect();
  assert.equal(snap.now, 1_000_000);
  assert.equal(snap.unallocated, 0);
  assert.equal(snap.totalFeesCharged, 0);
  assert.equal(snap.installments.length, 2);
  plan.close();
  cleanupAll();
});
