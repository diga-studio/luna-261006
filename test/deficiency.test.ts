import { test } from "node:test";
import assert from "node:assert/strict";
import { plan, verify, type PlanInput } from "../src/index.js";

const noConflict = (id: string): PlanInput["projects"][number] => ({
  id,
  creatorId: "outsider",
  stakeholderIds: [],
  history: [],
});

/**
 * Total capacity (9) exceeds total demand (5) and every task is individually
 * feasible, yet t1/t2/t3 all compete for the same two judges a and b, while
 * judge c is excluded everywhere as the shared creator.
 */
function sharedBottleneckInput(): PlanInput {
  return {
    judges: [
      { id: "a", baseLoad: 0, capacity: 2 },
      { id: "b", baseLoad: 0, capacity: 2 },
      { id: "c", baseLoad: 0, capacity: 5 },
    ],
    tasks: [
      { id: "t1", projectId: "p1", kind: "normal", requiredJudges: 2, lockedJudgeIds: [], preferredJudgeIds: [] },
      { id: "t2", projectId: "p2", kind: "normal", requiredJudges: 2, lockedJudgeIds: [], preferredJudgeIds: [] },
      { id: "t3", projectId: "p3", kind: "normal", requiredJudges: 1, lockedJudgeIds: [], preferredJudgeIds: [] },
    ],
    projects: [
      { id: "p1", creatorId: "c", stakeholderIds: [], history: [] },
      { id: "p2", creatorId: "c", stakeholderIds: [], history: [] },
      { id: "p3", creatorId: "c", stakeholderIds: [], history: [] },
    ],
  };
}

test("infeasible instance yields verifiable deficiency evidence", () => {
  const input = sharedBottleneckInput();
  const result = plan(input);
  assert.ok(!result.ok);
  assert.deepEqual(new Set(result.deficiency.taskIds), new Set(["t1", "t2", "t3"]));
  assert.ok(verify(input, result));
});

test("verify rejects tampered deficiency evidence", () => {
  const input = sharedBottleneckInput();
  const result = plan(input);
  assert.ok(!result.ok);

  // Shrinking the set breaks the inequality: 2+2 slots vs 4 contribution.
  const shrunk = { ok: false as const, deficiency: { taskIds: ["t1", "t2"] } };
  assert.equal(verify(input, shrunk), false);

  const singleton = { ok: false as const, deficiency: { taskIds: ["t3"] } };
  assert.equal(verify(input, singleton), false);

  const empty = { ok: false as const, deficiency: { taskIds: [] } };
  assert.equal(verify(input, empty), false);

  const unknown = { ok: false as const, deficiency: { taskIds: ["t1", "t2", "t3", "ghost"] } };
  assert.equal(verify(input, unknown), false);

  const duplicated = { ok: false as const, deficiency: { taskIds: ["t1", "t1", "t2", "t3"] } };
  assert.equal(verify(input, duplicated), false);
});

test("deficiency accounting deducts locked occupancy first", () => {
  // a is locked to t1, so a contributes only its remaining capacity (1).
  const input: PlanInput = {
    judges: [
      { id: "a", baseLoad: 0, capacity: 2 },
      { id: "b", baseLoad: 0, capacity: 2 },
    ],
    tasks: [
      { id: "t1", projectId: "p1", kind: "normal", requiredJudges: 2, lockedJudgeIds: ["a"], preferredJudgeIds: [] },
      { id: "t2", projectId: "p2", kind: "normal", requiredJudges: 2, lockedJudgeIds: [], preferredJudgeIds: [] },
      { id: "t3", projectId: "p3", kind: "normal", requiredJudges: 1, lockedJudgeIds: [], preferredJudgeIds: [] },
    ],
    projects: [noConflict("p1"), noConflict("p2"), noConflict("p3")],
  };
  const result = plan(input);
  assert.ok(!result.ok);
  // Remaining demand 1+2+1=4; contributions a:min(1,2)=1, b:min(2,3)=2.
  assert.ok(verify(input, result));
  assert.deepEqual(new Set(result.deficiency.taskIds), new Set(["t1", "t2", "t3"]));
});

test("locked-occupied judge is not double counted as a candidate", () => {
  // Feasible exactly because the locked pair frees no phantom candidate slot:
  // t1 needs 1 more (only b qualifies), t2 needs 2 (a and b).
  const input: PlanInput = {
    judges: [
      { id: "a", baseLoad: 0, capacity: 2 },
      { id: "b", baseLoad: 0, capacity: 2 },
    ],
    tasks: [
      { id: "t1", projectId: "p1", kind: "normal", requiredJudges: 2, lockedJudgeIds: ["a"], preferredJudgeIds: [] },
      { id: "t2", projectId: "p2", kind: "normal", requiredJudges: 2, lockedJudgeIds: [], preferredJudgeIds: [] },
    ],
    projects: [noConflict("p1"), noConflict("p2")],
  };
  const result = plan(input);
  assert.ok(result.ok);
  assert.ok(verify(input, result));
});
