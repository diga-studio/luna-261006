import { test } from "node:test";
import assert from "node:assert/strict";
import { plan, verify, type PlanInput } from "../src/index.js";
import { bruteForce, randomInstance } from "./reference.js";

test("appeal excludes judges from every historical round, not just the last", () => {
  const input: PlanInput = {
    judges: [
      { id: "old", baseLoad: 0, capacity: 5 },
      { id: "recent", baseLoad: 0, capacity: 5 },
      { id: "fresh", baseLoad: 0, capacity: 5 },
    ],
    tasks: [
      {
        id: "appealTask",
        projectId: "p",
        kind: "appeal",
        requiredJudges: 1,
        lockedJudgeIds: [],
        preferredJudgeIds: [],
      },
    ],
    projects: [
      {
        id: "p",
        creatorId: "nobody",
        stakeholderIds: [],
        history: [["old"], ["recent"]],
      },
    ],
  };
  const result = plan(input);
  assert.ok(result.ok);
  assert.deepEqual(result.assignments["appealTask"], ["fresh"]);
  assert.ok(verify(input, result));
});

test("normal tasks may reuse historical judges", () => {
  const input: PlanInput = {
    judges: [
      { id: "old", baseLoad: 0, capacity: 5 },
      { id: "other", baseLoad: 10, capacity: 5 },
    ],
    tasks: [
      {
        id: "t",
        projectId: "p",
        kind: "normal",
        requiredJudges: 1,
        lockedJudgeIds: [],
        preferredJudgeIds: [],
      },
    ],
    projects: [
      { id: "p", creatorId: "nobody", stakeholderIds: [], history: [["old"]] },
    ],
  };
  const result = plan(input);
  assert.ok(result.ok);
  assert.deepEqual(result.assignments["t"], ["old"]);
});

test("locked pairs occupy judge capacity", () => {
  const input: PlanInput = {
    judges: [
      { id: "a", baseLoad: 0, capacity: 1 },
      { id: "b", baseLoad: 0, capacity: 1 },
    ],
    tasks: [
      {
        id: "t1",
        projectId: "p1",
        kind: "normal",
        requiredJudges: 1,
        lockedJudgeIds: ["a"],
        preferredJudgeIds: [],
      },
      {
        id: "t2",
        projectId: "p2",
        kind: "normal",
        requiredJudges: 1,
        lockedJudgeIds: [],
        preferredJudgeIds: [],
      },
    ],
    projects: [
      { id: "p1", creatorId: "x", stakeholderIds: [], history: [] },
      { id: "p2", creatorId: "x", stakeholderIds: [], history: [] },
    ],
  };
  const result = plan(input);
  assert.ok(result.ok);
  assert.deepEqual(result.assignments["t1"], ["a"]);
  assert.deepEqual(result.assignments["t2"], ["b"]);
  assert.equal(result.objectives.loadSquares, 2);
});

test("load balance beats preference adoption", () => {
  const input: PlanInput = {
    judges: [
      { id: "loved", baseLoad: 0, capacity: 5 },
      { id: "plain", baseLoad: 0, capacity: 5 },
    ],
    tasks: [
      {
        id: "t1",
        projectId: "p1",
        kind: "normal",
        requiredJudges: 1,
        lockedJudgeIds: [],
        preferredJudgeIds: ["loved"],
      },
      {
        id: "t2",
        projectId: "p2",
        kind: "normal",
        requiredJudges: 1,
        lockedJudgeIds: [],
        preferredJudgeIds: ["loved"],
      },
    ],
    projects: [
      { id: "p1", creatorId: "x", stakeholderIds: [], history: [] },
      { id: "p2", creatorId: "x", stakeholderIds: [], history: [] },
    ],
  };
  const result = plan(input);
  assert.ok(result.ok);
  // Balanced loads (1+1) beat adopting both preferences (2+0).
  assert.equal(result.objectives.loadSquares, 2);
  assert.equal(result.objectives.unadoptedPreferences, 1);
  assert.ok(verify(input, result));
});

test("preferences break ties among equally balanced optima", () => {
  const input: PlanInput = {
    judges: [
      { id: "a", baseLoad: 0, capacity: 5 },
      { id: "b", baseLoad: 0, capacity: 5 },
    ],
    tasks: [
      {
        id: "t1",
        projectId: "p1",
        kind: "normal",
        requiredJudges: 1,
        lockedJudgeIds: [],
        preferredJudgeIds: ["a"],
      },
    ],
    projects: [
      { id: "p1", creatorId: "x", stakeholderIds: [], history: [] },
    ],
  };
  const result = plan(input);
  assert.ok(result.ok);
  assert.deepEqual(result.assignments["t1"], ["a"]);
  assert.equal(result.objectives.unadoptedPreferences, 0);
});

test("random small instances match exhaustive reference", () => {
  const configs = [
    { judgeCount: 5, taskCount: 4, maxRequired: 3, maxCapacity: 3, maxBaseLoad: 3, appealRatio: 0.4, lockRatio: 0.5, prefCount: 3, historyRounds: 3 },
    { judgeCount: 6, taskCount: 5, maxRequired: 4, maxCapacity: 4, maxBaseLoad: 2, appealRatio: 0.5, lockRatio: 0.6, prefCount: 4, historyRounds: 4 },
    { judgeCount: 4, taskCount: 3, maxRequired: 3, maxCapacity: 2, maxBaseLoad: 4, appealRatio: 0.3, lockRatio: 0.4, prefCount: 2, historyRounds: 2 },
  ];
  for (let seed = 1; seed <= 300; seed += 1) {
    const config = configs[seed % configs.length]!;
    const input = randomInstance({ seed, ...config });
    const expected = bruteForce(input);
    const result = plan(input);
    assert.equal(
      result.ok,
      expected.feasible,
      `feasibility mismatch on seed ${seed}`,
    );
    if (expected.feasible && result.ok) {
      assert.deepEqual(
        result.objectives,
        expected.objectives,
        `objective mismatch on seed ${seed}`,
      );
      assert.ok(verify(input, result), `verify rejected seed ${seed}`);
    } else if (!result.ok) {
      assert.ok(verify(input, result), `certificate rejected on seed ${seed}`);
    }
  }
});

test("verify rejects tampered successful results", () => {
  let input: PlanInput | undefined;
  let result: ReturnType<typeof plan> | undefined;
  for (let seed = 1; seed < 100; seed += 1) {
    const candidate = randomInstance({
      seed,
      judgeCount: 5,
      taskCount: 4,
      maxRequired: 3,
      maxCapacity: 3,
      maxBaseLoad: 2,
      appealRatio: 0.3,
      lockRatio: 0.5,
      prefCount: 3,
      historyRounds: 2,
    });
    const planned = plan(candidate);
    if (planned.ok && planned.objectives.unadoptedPreferences > 0) {
      input = candidate;
      result = planned;
      break;
    }
  }
  assert.ok(input !== undefined && result !== undefined && result.ok);

  const wrongLoad = {
    ...result,
    objectives: { ...result.objectives, loadSquares: result.objectives.loadSquares + 1 },
  };
  assert.equal(verify(input, wrongLoad), false);

  const wrongPrefs = {
    ...result,
    objectives: {
      ...result.objectives,
      unadoptedPreferences: result.objectives.unadoptedPreferences + 1,
    },
  };
  assert.equal(verify(input, wrongPrefs), false);

  const firstTask = input.tasks[0]!;
  const shrunk = {
    ...result,
    assignments: {
      ...result.assignments,
      [firstTask.id]: result.assignments[firstTask.id]!.slice(1),
    },
  };
  assert.equal(verify(input, shrunk), false);

  const missing = { ...result, assignments: { ...result.assignments } };
  delete missing.assignments[firstTask.id];
  assert.equal(verify(input, missing), false);
});
