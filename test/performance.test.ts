import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluatePlan, planBatch } from "../src/index.js";
import type { Mentor, Newcomer, PlanInput } from "../src/index.js";
import { makeRng, objectiveOf, pickInt, pickSubset } from "./helpers.js";

const DEPARTMENTS = ["eng", "sales", "ops", "design"];
const LOCATIONS = ["sh", "bj", "sz"];
const TAGS = Array.from({ length: 12 }, (_, i) => `tag${i}`);

/** 可重复地生成 300 新人 / 200 导师 / 60000 候选关系的实例 */
function largeInstance(seed: number): PlanInput {
  const rng = makeRng(seed);
  const mentors: Mentor[] = [];
  for (let j = 0; j < 200; j += 1) {
    mentors.push({
      id: `m${j}`,
      department: DEPARTMENTS[pickInt(rng, 0, DEPARTMENTS.length - 1)]!,
      location: LOCATIONS[pickInt(rng, 0, LOCATIONS.length - 1)]!,
      interests: pickSubset(rng, TAGS, 0, 6),
      activeMenteeCount: pickInt(rng, 0, 2), // 保证总容量 200*(3-2)=200..600 中偏上
    });
  }
  const allMentorIds = mentors.map((m) => m.id);
  const newcomers: Newcomer[] = [];
  for (let i = 0; i < 300; i += 1) {
    newcomers.push({
      id: `n${i}`,
      department: DEPARTMENTS[pickInt(rng, 0, DEPARTMENTS.length - 1)]!,
      location: LOCATIONS[pickInt(rng, 0, LOCATIONS.length - 1)]!,
      interests: pickSubset(rng, TAGS, 0, 6),
      // 每名新人 200 条候选 => 300 * 200 = 60000 条候选关系
      candidateMentorIds: new Set(allMentorIds),
    });
  }
  // 60 条互不冲突的强制指定
  const forcedAssignments: { newcomerId: string; mentorId: string }[] = [];
  const loadByMentor = new Map(mentors.map((m) => [m.id, m.activeMenteeCount]));
  for (let i = 0; i < 60; i += 1) {
    const newcomer = newcomers[i]!;
    const free = allMentorIds.filter((id) => loadByMentor.get(id)! < 3);
    const mentorId = free[pickInt(rng, 0, free.length - 1)]!;
    forcedAssignments.push({ newcomerId: newcomer.id, mentorId });
    loadByMentor.set(mentorId, loadByMentor.get(mentorId)! + 1);
  }
  return { newcomers, mentors, forcedAssignments };
}

describe("planBatch at full scale (300 newcomers, 200 mentors, 60000 candidates)", () => {
  it("solves within 20s and the plan verifies end to end", () => {
    const input = largeInstance(42);
    const startedAt = performance.now();
    const result = planBatch(input);
    const elapsedMs = performance.now() - startedAt;

    if (!result.feasible) assert.fail("expected feasible plan");
    assert.ok(elapsedMs < 20_000, `planning took ${elapsedMs}ms`);

    // 容量、候选关系、强制指定全部合法
    const evaluation = evaluatePlan(input, result.assignments);
    assert.ok(evaluation.valid, evaluation.violations.join("; "));

    // 目标值与独立重算一致（不轻信方案附带分数）
    const recomputed = objectiveOf(input, result.assignments);
    assert.equal(result.objective.matchedCount, recomputed.matchedCount);
    assert.equal(result.objective.totalScore, recomputed.totalScore);
    assert.equal(evaluation.totalScore, recomputed.totalScore);

    // 候选集合为全量时，最大配对数 = min(新人数, 导师剩余容量总和)
    const residualCapacity = input.mentors.reduce((sum, m) => {
      const forced = input.forcedAssignments.filter((f) => f.mentorId === m.id).length;
      return sum + (3 - m.activeMenteeCount - forced);
    }, 0);
    const expectedMatched = Math.min(input.newcomers.length, residualCapacity);
    assert.equal(result.objective.matchedCount, expectedMatched);
    assert.equal(result.unassignedNewcomerIds.length, input.newcomers.length - expectedMatched);

    // 可重复：同一输入再次规划得到相同目标值
    const again = planBatch(input);
    if (!again.feasible) assert.fail("expected feasible plan on rerun");
    assert.deepEqual(again.objective, result.objective);

    console.log(
      `    full-scale plan: ${result.objective.matchedCount} matched, ` +
        `score ${result.objective.totalScore}, ${elapsedMs.toFixed(0)}ms`,
    );
  });
});
