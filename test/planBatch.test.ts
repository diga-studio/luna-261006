import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluatePlan, planBatch } from "../src/index.js";
import type { PlanInput } from "../src/index.js";
import {
  bruteForceOptimal,
  compareObjective,
  makeRng,
  randomInstance,
} from "./helpers.js";

const SMALL_OPTS = {
  newcomerCount: [2, 8] as [number, number],
  mentorCount: [1, 4] as [number, number],
  candidateMin: 0,
  candidateMax: 3,
  forcedCount: [0, 2] as [number, number],
  departments: ["eng", "sales"],
  locations: ["sh", "bj"],
  tags: ["t1", "t2", "t3", "t4", "t5"],
};

describe("planBatch vs brute force", () => {
  it("matches exhaustive optimum on small random instances", () => {
    const rng = makeRng(20261005);
    let withForced = 0;
    let withUnassigned = 0;
    for (let trial = 0; trial < 400; trial += 1) {
      const input = randomInstance(rng, SMALL_OPTS);
      const result = planBatch(input);
      if (!result.feasible) assert.fail(`trial ${trial}: expected feasible plan`);
      const optimal = bruteForceOptimal(input);
      assert.equal(
        compareObjective(result.objective, optimal),
        0,
        `trial ${trial}: objective ${JSON.stringify(result.objective)} != optimal ${JSON.stringify(optimal)}`,
      );
      // 方案必须合法，且 evaluatePlan 重算的目标与返回值一致
      const evaluation = evaluatePlan(input, result.assignments);
      assert.ok(evaluation.valid, `trial ${trial}: plan must be valid: ${evaluation.violations}`);
      assert.equal(evaluation.matchedCount, result.objective.matchedCount);
      assert.equal(evaluation.totalScore, result.objective.totalScore);
      assert.equal(
        result.assignments.length + result.unassignedNewcomerIds.length,
        input.newcomers.length,
      );
      if (input.forcedAssignments.length > 0) withForced += 1;
      if (result.unassignedNewcomerIds.length > 0) withUnassigned += 1;
    }
    // 确认随机用例确实覆盖了强制指定与容量不足的场景
    assert.ok(withForced > 50, `expected forced cases, got ${withForced}`);
    assert.ok(withUnassigned > 20, `expected capacity-shortage cases, got ${withUnassigned}`);
  });

  it("matches exhaustive optimum with heavily overlapping candidate sets", () => {
    const rng = makeRng(777);
    for (let trial = 0; trial < 300; trial += 1) {
      const input = randomInstance(rng, {
        ...SMALL_OPTS,
        newcomerCount: [4, 8],
        mentorCount: [1, 2],
        candidateMin: 1,
        candidateMax: 2,
        forcedCount: [0, 3],
      });
      const result = planBatch(input);
      if (!result.feasible) assert.fail(`trial ${trial}: expected feasible plan`);
      const optimal = bruteForceOptimal(input);
      assert.equal(compareObjective(result.objective, optimal), 0, `trial ${trial}`);
    }
  });

  it("does not let flexible newcomers steal the only slot of a single-candidate newcomer", () => {
    // m1 仅剩 1 个名额；n1 只能选 m1；n2 可选 m1 或 m2。
    // 最优：n1->m1, n2->m2（2 人配对）。若 n2 抢占 m1，则 n1 无法分配，只剩 1 人。
    const input: PlanInput = {
      mentors: [
        { id: "m1", department: "eng", location: "sh", interests: new Set(["a"]), activeMenteeCount: 2 },
        { id: "m2", department: "eng", location: "sh", interests: new Set(["b"]), activeMenteeCount: 0 },
      ],
      newcomers: [
        { id: "n1", department: "eng", location: "sh", interests: new Set(["a"]), candidateMentorIds: new Set(["m1"]) },
        { id: "n2", department: "eng", location: "sh", interests: new Set(["a", "b"]), candidateMentorIds: new Set(["m1", "m2"]) },
      ],
      forcedAssignments: [],
    };
    const result = planBatch(input);
    if (!result.feasible) assert.fail("expected feasible plan");
    assert.equal(result.objective.matchedCount, 2);
    const mentorOf = new Map(result.assignments.map((a) => [a.newcomerId, a.mentorId]));
    assert.equal(mentorOf.get("n1"), "m1");
    assert.equal(mentorOf.get("n2"), "m2");
  });
});

describe("planBatch forced-assignment conflicts", () => {
  const base: PlanInput = {
    mentors: [
      { id: "m1", department: "eng", location: "sh", interests: new Set(), activeMenteeCount: 0 },
      { id: "m2", department: "eng", location: "sh", interests: new Set(), activeMenteeCount: 3 },
    ],
    newcomers: [
      { id: "n1", department: "eng", location: "sh", interests: new Set(), candidateMentorIds: new Set(["m1", "m2"]) },
      { id: "n2", department: "eng", location: "sh", interests: new Set(), candidateMentorIds: new Set(["m1"]) },
    ],
    forcedAssignments: [],
  };

  it("reports infeasible when one newcomer is forced to two mentors", () => {
    const result = planBatch({
      ...base,
      forcedAssignments: [
        { newcomerId: "n1", mentorId: "m1" },
        { newcomerId: "n1", mentorId: "m2" },
      ],
    });
    assert.ok(!result.feasible);
  });

  it("reports infeasible when forced assignments exceed mentor capacity", () => {
    // m2 历史负载已为 3，再强制指定必然超容量
    const result = planBatch({
      ...base,
      forcedAssignments: [{ newcomerId: "n1", mentorId: "m2" }],
    });
    assert.ok(!result.feasible);
  });

  it("reports infeasible when forced pair is not in the candidate set", () => {
    const result = planBatch({
      ...base,
      forcedAssignments: [{ newcomerId: "n2", mentorId: "m2" }],
    });
    assert.ok(!result.feasible);
  });

  it("reports infeasible for unknown ids in forced assignments", () => {
    const result = planBatch({
      ...base,
      forcedAssignments: [{ newcomerId: "ghost", mentorId: "m1" }],
    });
    assert.ok(!result.feasible);
  });
});
