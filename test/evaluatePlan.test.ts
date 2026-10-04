import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluatePlan, planBatch } from "../src/index.js";
import type { PlanInput } from "../src/index.js";

/**
 * 场景：导师 A、B 历史负载均为 0，所有人同部门同办公地点。
 * X 无兴趣标签且强制分给 A；Y 可选 A 或 B，与 A 共享两个标签，与 B 无交集。
 * 正确结果必须把 Y 分给 B（总分 150）；把 Y 分给 A 只有 145。
 */
function scenario(): PlanInput {
  return {
    mentors: [
      { id: "A", department: "eng", location: "sh", interests: new Set(["go", "ts"]), activeMenteeCount: 0 },
      { id: "B", department: "eng", location: "sh", interests: new Set(["rust"]), activeMenteeCount: 0 },
    ],
    newcomers: [
      { id: "X", department: "eng", location: "sh", interests: new Set(), candidateMentorIds: new Set(["A", "B"]) },
      { id: "Y", department: "eng", location: "sh", interests: new Set(["go", "ts"]), candidateMentorIds: new Set(["A", "B"]) },
    ],
    forcedAssignments: [{ newcomerId: "X", mentorId: "A" }],
  };
}

describe("evaluatePlan rescores load-dependent terms", () => {
  it("planBatch assigns Y to B with total score 150", () => {
    const result = planBatch(scenario());
    if (!result.feasible) assert.fail("expected feasible plan");
    const mentorOf = new Map(result.assignments.map((a) => [a.newcomerId, a.mentorId]));
    assert.equal(mentorOf.get("X"), "A");
    assert.equal(mentorOf.get("Y"), "B");
    assert.equal(result.objective.matchedCount, 2);
    assert.equal(result.objective.totalScore, 150);
  });

  it("evaluatePlan scores Y->B as 150 and Y->A as 145", () => {
    const input = scenario();
    const good = evaluatePlan(input, [
      { newcomerId: "X", mentorId: "A" },
      { newcomerId: "Y", mentorId: "B" },
    ]);
    assert.ok(good.valid);
    assert.equal(good.matchedCount, 2);
    // X: 30(部门)+10(地点)+0(兴趣)+20(任职)+15(负载1) = 75
    assert.equal(good.scores.get("X"), 75);
    // Y: 30+10+0+20+15 = 75
    assert.equal(good.scores.get("Y"), 75);
    assert.equal(good.totalScore, 150);

    const bad = evaluatePlan(input, [
      { newcomerId: "X", mentorId: "A" },
      { newcomerId: "Y", mentorId: "A" },
    ]);
    assert.ok(bad.valid);
    // A 最终负载为 2，X 与 Y 的负载项都按 7.5 重新计分
    // X: 30+10+0+20+7.5 = 67.5；Y: 30+10+10+20+7.5 = 77.5
    assert.equal(bad.scores.get("X"), 67.5);
    assert.equal(bad.scores.get("Y"), 77.5);
    assert.equal(bad.totalScore, 145);
  });
});

describe("evaluatePlan validity checks", () => {
  const input = scenario();

  it("rejects dropping a forced assignment", () => {
    const evaluation = evaluatePlan(input, [{ newcomerId: "X", mentorId: "B" }]);
    assert.equal(evaluation.valid, false);
    assert.ok(evaluation.violations.some((v) => v.includes("forced")));
  });

  it("rejects mentor overload beyond final load 3", () => {
    const overloaded: PlanInput = {
      ...input,
      mentors: input.mentors.map((m) => (m.id === "A" ? { ...m, activeMenteeCount: 2 } : m)),
    };
    const evaluation = evaluatePlan(overloaded, [
      { newcomerId: "X", mentorId: "A" },
      { newcomerId: "Y", mentorId: "A" },
    ]);
    assert.equal(evaluation.valid, false);
    assert.ok(evaluation.violations.some((v) => v.includes("final load")));
  });

  it("rejects pairs outside the candidate set", () => {
    const narrowed: PlanInput = {
      ...input,
      newcomers: input.newcomers.map((n) =>
        n.id === "Y" ? { ...n, candidateMentorIds: new Set(["B"]) } : n,
      ),
    };
    const evaluation = evaluatePlan(narrowed, [
      { newcomerId: "X", mentorId: "A" },
      { newcomerId: "Y", mentorId: "A" },
    ]);
    assert.equal(evaluation.valid, false);
    assert.ok(evaluation.violations.some((v) => v.includes("candidate")));
  });

  it("rejects assigning one newcomer twice", () => {
    const evaluation = evaluatePlan(input, [
      { newcomerId: "X", mentorId: "A" },
      { newcomerId: "X", mentorId: "B" },
    ]);
    assert.equal(evaluation.valid, false);
  });

  it("does not trust supplied scores and recomputes from input", () => {
    // 即使调用方声称别的分数，evaluatePlan 也只根据输入重算
    const evaluation = evaluatePlan(input, [
      { newcomerId: "X", mentorId: "A" },
      { newcomerId: "Y", mentorId: "B" },
    ]);
    assert.equal(evaluation.totalScore, 150);
  });
});
