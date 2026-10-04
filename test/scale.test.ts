import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluatePlan, planBatch } from "../src/index.js";
import type { BatchInput, Mentor, Newcomer } from "../src/types.js";
import { makeRng, pickInt } from "./helpers.js";

function generateScaleInstance(seed: number): BatchInput {
  const rng = makeRng(seed);
  const mentorCount = 200;
  const newcomerCount = 300;

  const mentors: Mentor[] = [];
  for (let i = 0; i < mentorCount; i += 1) {
    const interests = new Set<string>();
    while (interests.size < pickInt(rng, 0, 8)) interests.add(`tag${pickInt(rng, 0, 39)}`);
    mentors.push({
      id: `m${i}`,
      department: `dept${pickInt(rng, 0, 11)}`,
      location: `loc${pickInt(rng, 0, 5)}`,
      interests,
      historicalActive: pickInt(rng, 0, 3),
    });
  }

  const newcomers: Newcomer[] = [];
  for (let i = 0; i < newcomerCount; i += 1) {
    const interests = new Set<string>();
    while (interests.size < pickInt(rng, 0, 8)) interests.add(`tag${pickInt(rng, 0, 39)}`);
    // 300 * 200 = 60000 candidate relations in total.
    newcomers.push({
      id: `n${i}`,
      department: `dept${pickInt(rng, 0, 11)}`,
      location: `loc${pickInt(rng, 0, 5)}`,
      interests,
      candidateMentorIds: mentors.map((m) => m.id),
    });
  }

  const forced: Array<{ newcomerId: string; mentorId: string }> = [];
  const forcedLoad = new Map<string, number>();
  for (const newcomer of newcomers) {
    if (rng() >= 0.2) continue;
    const mentor = mentors[pickInt(rng, 0, mentorCount - 1)];
    const used = forcedLoad.get(mentor.id) ?? 0;
    if (mentor.historicalActive + used + 1 <= 3) {
      forced.push({ newcomerId: newcomer.id, mentorId: mentor.id });
      forcedLoad.set(mentor.id, used + 1);
    }
  }
  return { newcomers, mentors, forced };
}

describe("scale: 300 newcomers, 200 mentors, 60000 candidate relations", () => {
  const input = generateScaleInstance(20261005);
  const relationCount = input.newcomers.reduce((sum, n) => sum + n.candidateMentorIds.length, 0);

  it("uses the required instance size", () => {
    assert.equal(input.newcomers.length, 300);
    assert.equal(input.mentors.length, 200);
    assert.equal(relationCount, 60000);
    assert.ok(input.forced.length > 0, "instance should contain forced pairs");
  });

  it("plans the full batch within 20 seconds and the plan verifies", () => {
    const started = performance.now();
    const plan = planBatch(input);
    const elapsedMs = performance.now() - started;
    assert.ok(elapsedMs < 20_000, `planning took ${elapsedMs.toFixed(0)}ms`);

    assert.equal(plan.feasible, true);
    assert.equal(plan.matchedCount + plan.unassignedNewcomerIds.length, input.newcomers.length);

    // Capacity: final load (historical + batch) never exceeds 3.
    const batchLoad = new Map<string, number>();
    for (const a of plan.assignments) {
      batchLoad.set(a.mentorId, (batchLoad.get(a.mentorId) ?? 0) + 1);
    }
    for (const m of input.mentors) {
      assert.ok(m.historicalActive + (batchLoad.get(m.id) ?? 0) <= 3, `mentor ${m.id} overloaded`);
    }

    // Candidate relations are respected.
    const candidates = new Map(input.newcomers.map((n) => [n.id, new Set(n.candidateMentorIds)]));
    for (const a of plan.assignments) {
      assert.ok(candidates.get(a.newcomerId)?.has(a.mentorId), `${a.newcomerId} -> ${a.mentorId} not a candidate`);
    }

    // Forced pairs are preserved.
    const byNewcomer = new Map(plan.assignments.map((a) => [a.newcomerId, a.mentorId]));
    for (const f of input.forced) {
      assert.equal(byNewcomer.get(f.newcomerId), f.mentorId, `forced pair ${f.newcomerId} dropped`);
    }

    // The reported objective matches an independent recomputation.
    const evaluation = evaluatePlan(input, plan.assignments);
    assert.equal(evaluation.valid, true);
    assert.equal(evaluation.matchedCount, plan.matchedCount);
    assert.equal(evaluation.totalScore, plan.totalScore);
    assert.deepEqual(evaluation.scores, plan.scores);

    // Per-newcomer scores are consistent with the total.
    let sum = 0;
    for (const a of plan.assignments) sum += plan.scores[a.newcomerId];
    assert.equal(sum, plan.totalScore);

    console.log(
      `    scale run: ${elapsedMs.toFixed(0)}ms, matched ${plan.matchedCount}/300, total score ${plan.totalScore}`,
    );
  });
});
