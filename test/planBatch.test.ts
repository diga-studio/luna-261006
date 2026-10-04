import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluatePlan, planBatch } from "../src/index.js";
import type { BatchInput } from "../src/types.js";
import { bruteForceOptimal, generateInstance } from "./helpers.js";

describe("planBatch vs brute force on small random instances", () => {
  const scenarios = [
    // Overlapping candidate sets, plenty of capacity.
    { newcomerCount: 6, mentorCount: 3, candidateRange: [1, 3] as [number, number], departments: 2, locations: 2, interestTags: 4, maxInterests: 3, forcedRate: 0.3 },
    // Capacity shortage: more newcomers than remaining slots.
    { newcomerCount: 8, mentorCount: 3, candidateRange: [1, 4] as [number, number], departments: 2, locations: 1, interestTags: 3, maxInterests: 2, forcedRate: 0.25, historicalWeights: [1, 2, 3, 4] as [number, number, number, number] },
    // Heavy forcing with tight capacity.
    { newcomerCount: 7, mentorCount: 4, candidateRange: [2, 4] as [number, number], departments: 1, locations: 2, interestTags: 5, maxInterests: 4, forcedRate: 0.5 },
  ];

  for (const [caseIndex, scenario] of scenarios.entries()) {
    it(`matches the exhaustive optimum (scenario ${caseIndex})`, () => {
      for (let seed = 1; seed <= 40; seed += 1) {
        const input = generateInstance(seed * 7919 + caseIndex, scenario);
        const plan = planBatch(input);
        assert.equal(plan.feasible, true, `seed ${seed}: expected a feasible plan`);
        const optimal = bruteForceOptimal(input);
        assert.equal(
          plan.matchedCount,
          optimal.matchedCount,
          `seed ${seed}: matched count must be maximal`,
        );
        assert.equal(
          plan.totalScore,
          optimal.totalScore,
          `seed ${seed}: total score must be optimal among max-count plans`,
        );
        const evaluation = evaluatePlan(input, plan.assignments);
        assert.equal(evaluation.valid, true, `seed ${seed}: plan must be legal`);
        assert.equal(evaluation.totalScore, plan.totalScore);
        assert.equal(evaluation.matchedCount, plan.matchedCount);
      }
    });
  }

  it("does not let a newcomer with many candidates steal the only slot of a single-candidate newcomer", () => {
    const input: BatchInput = {
      mentors: [
        { id: "m-only", department: "d1", location: "l1", interests: new Set(["a"]), historicalActive: 2 },
        { id: "m-other", department: "d2", location: "l2", interests: new Set(["b"]), historicalActive: 0 },
      ],
      newcomers: [
        { id: "n-single", department: "d1", location: "l1", interests: new Set(["a"]), candidateMentorIds: ["m-only"] },
        { id: "n-flex", department: "d1", location: "l1", interests: new Set(["a"]), candidateMentorIds: ["m-only", "m-other"] },
      ],
      forced: [],
    };
    const plan = planBatch(input);
    assert.equal(plan.feasible, true);
    assert.equal(plan.matchedCount, 2, "both newcomers must be matched");
    const byNewcomer = new Map(plan.assignments.map((a) => [a.newcomerId, a.mentorId]));
    assert.equal(byNewcomer.get("n-single"), "m-only");
    assert.equal(byNewcomer.get("n-flex"), "m-other");
  });
});

describe("forced pair conflicts", () => {
  const baseMentor = { id: "m1", department: "d", location: "l", interests: new Set<string>(), historicalActive: 0 };
  const baseNewcomer = { id: "n1", department: "d", location: "l", interests: new Set<string>(), candidateMentorIds: ["m1", "m2"] };
  const mentor2 = { ...baseMentor, id: "m2" };

  it("reports infeasible when a newcomer is forced to two mentors", () => {
    const plan = planBatch({
      mentors: [baseMentor, mentor2],
      newcomers: [baseNewcomer],
      forced: [
        { newcomerId: "n1", mentorId: "m1" },
        { newcomerId: "n1", mentorId: "m2" },
      ],
    });
    assert.equal(plan.feasible, false);
    assert.equal(plan.matchedCount, 0);
  });

  it("reports infeasible when forced pairs exceed a mentor's capacity", () => {
    const newcomers = [0, 1, 2, 3].map((i) => ({
      id: `n${i}`,
      department: "d",
      location: "l",
      interests: new Set<string>(),
      candidateMentorIds: ["m1"],
    }));
    const plan = planBatch({
      mentors: [{ ...baseMentor, historicalActive: 0 }],
      newcomers,
      forced: newcomers.map((n) => ({ newcomerId: n.id, mentorId: "m1" })),
    });
    assert.equal(plan.feasible, false);
  });

  it("reports infeasible when a forced pair is outside the candidate set", () => {
    const plan = planBatch({
      mentors: [baseMentor, mentor2],
      newcomers: [{ ...baseNewcomer, candidateMentorIds: ["m1"] }],
      forced: [{ newcomerId: "n1", mentorId: "m2" }],
    });
    assert.equal(plan.feasible, false);
  });
});

describe("load term consistency for forced pairs", () => {
  // Mentors A and B both have historical load 0; everyone shares department
  // and location. X has no interests and is forced to A. Y may use A or B,
  // shares two interest tags with A and none with B.
  const input: BatchInput = {
    mentors: [
      { id: "A", department: "eng", location: "hq", interests: new Set(["t1", "t2"]), historicalActive: 0 },
      { id: "B", department: "eng", location: "hq", interests: new Set(["t3"]), historicalActive: 0 },
    ],
    newcomers: [
      { id: "X", department: "eng", location: "hq", interests: new Set<string>(), candidateMentorIds: ["A"] },
      { id: "Y", department: "eng", location: "hq", interests: new Set(["t1", "t2"]), candidateMentorIds: ["A", "B"] },
    ],
    forced: [{ newcomerId: "X", mentorId: "A" }],
  };

  it("assigns Y to B for a total score of 150", () => {
    const plan = planBatch(input);
    assert.equal(plan.feasible, true);
    assert.equal(plan.matchedCount, 2);
    const byNewcomer = new Map(plan.assignments.map((a) => [a.newcomerId, a.mentorId]));
    assert.equal(byNewcomer.get("X"), "A");
    assert.equal(byNewcomer.get("Y"), "B");
    assert.equal(plan.totalScore, 150);
  });

  it("evaluatePlan scores Y->B as 150 and Y->A as 145", () => {
    const good = evaluatePlan(input, [
      { newcomerId: "X", mentorId: "A" },
      { newcomerId: "Y", mentorId: "B" },
    ]);
    assert.equal(good.valid, true);
    assert.equal(good.matchedCount, 2);
    assert.equal(good.scores["X"], 75);
    assert.equal(good.scores["Y"], 75);
    assert.equal(good.totalScore, 150);

    const bad = evaluatePlan(input, [
      { newcomerId: "X", mentorId: "A" },
      { newcomerId: "Y", mentorId: "A" },
    ]);
    assert.equal(bad.valid, true, "both plans are legal; only the score differs");
    assert.equal(bad.scores["X"], 67.5);
    assert.equal(bad.scores["Y"], 77.5);
    assert.equal(bad.totalScore, 145);
  });
});

describe("evaluatePlan legality checks", () => {
  const input: BatchInput = {
    mentors: [
      { id: "m1", department: "d", location: "l", interests: new Set<string>(), historicalActive: 2 },
      { id: "m2", department: "d", location: "l", interests: new Set<string>(), historicalActive: 0 },
    ],
    newcomers: [
      { id: "n1", department: "d", location: "l", interests: new Set<string>(), candidateMentorIds: ["m1"] },
      { id: "n2", department: "d", location: "l", interests: new Set<string>(), candidateMentorIds: ["m2"] },
    ],
    forced: [{ newcomerId: "n2", mentorId: "m2" }],
  };

  it("rejects assignments outside the candidate set", () => {
    const result = evaluatePlan(input, [
      { newcomerId: "n1", mentorId: "m2" },
      { newcomerId: "n2", mentorId: "m2" },
    ]);
    assert.equal(result.valid, false);
    assert.ok(result.violations.some((v) => v.includes("not a candidate")));
  });

  it("rejects plans that drop a forced pair", () => {
    const result = evaluatePlan(input, [{ newcomerId: "n1", mentorId: "m1" }]);
    assert.equal(result.valid, false);
    assert.ok(result.violations.some((v) => v.includes("forced pair")));
  });

  it("rejects plans that exceed final load 3", () => {
    const result = evaluatePlan(input, [
      { newcomerId: "n1", mentorId: "m1" },
      { newcomerId: "n2", mentorId: "m1" },
    ]);
    assert.equal(result.valid, false);
    assert.ok(result.violations.some((v) => v.includes("final load exceeds 3")));
  });

  it("rejects double assignment of one newcomer", () => {
    const result = evaluatePlan(input, [
      { newcomerId: "n1", mentorId: "m1" },
      { newcomerId: "n1", mentorId: "m1" },
      { newcomerId: "n2", mentorId: "m2" },
    ]);
    assert.equal(result.valid, false);
    assert.ok(result.violations.some((v) => v.includes("more than once")));
  });
});
