import { test } from "node:test";
import assert from "node:assert/strict";
import { plan, verify, type PlanInput } from "../src/index.js";
import { makeRng, randInt, shuffle } from "./reference.js";

const JUDGES = 200;
const TASKS = 300;
const SLOTS_PER_TASK = 4;

/**
 * Full-scale instance: 300 tasks x 4 slots = 1200 assignments over 200
 * judges, with locked pairs, preferences and appeal exclusions. Candidate
 * pairs stay below the 60k budget.
 */
function scaleInput(seed: number): PlanInput {
  const rng = makeRng(seed);
  const judges = Array.from({ length: JUDGES }, (_, i) => ({
    id: `j${i}`,
    baseLoad: randInt(rng, 0, 10),
    capacity: randInt(rng, 7, 10),
  }));
  const judgeIds = judges.map((j) => j.id);
  const lockedSoFar = new Map<string, number>();
  const projects: PlanInput["projects"] = [];
  const tasks: PlanInput["tasks"] = [];
  for (let t = 0; t < TASKS; t += 1) {
    const creatorId = judgeIds[randInt(rng, 0, JUDGES - 1)]!;
    const stakeholderIds = shuffle(judgeIds, rng).slice(0, 2);
    const kind = rng() < 0.3 ? "appeal" : "normal";
    const history: string[][] = [];
    for (let r = 0, rounds = randInt(rng, 1, 2); r < rounds; r += 1) {
      history.push(shuffle(judgeIds, rng).slice(0, 3));
    }
    const projectId = `p${t}`;
    projects.push({ id: projectId, creatorId, stakeholderIds, history });

    const excluded = new Set([creatorId, ...stakeholderIds]);
    if (kind === "appeal") {
      for (const round of history) for (const id of round) excluded.add(id);
    }
    let lockedJudgeIds: string[] = [];
    if (rng() < 0.5) {
      const lockable = judgeIds.filter((id) => {
        if (excluded.has(id)) return false;
        const judge = judges[Number(id.slice(1))]!;
        return (lockedSoFar.get(id) ?? 0) < judge.capacity - 1;
      });
      if (lockable.length > 0) {
        const picked = lockable[randInt(rng, 0, lockable.length - 1)]!;
        lockedJudgeIds = [picked];
        lockedSoFar.set(picked, (lockedSoFar.get(picked) ?? 0) + 1);
      }
    }
    const preferredJudgeIds = shuffle(judgeIds, rng).slice(0, 5);
    tasks.push({
      id: `t${t}`,
      projectId,
      kind,
      requiredJudges: SLOTS_PER_TASK,
      lockedJudgeIds,
      preferredJudgeIds,
    });
  }
  return { judges, tasks, projects };
}

test("full-scale instance plans within 30 seconds and verifies", () => {
  const input = scaleInput(7);
  const candidatePairs = input.tasks.length * JUDGES;
  assert.ok(candidatePairs <= 60_000 * 1.05); // eligibility only removes pairs

  const start = Date.now();
  const result = plan(input);
  const elapsedMs = Date.now() - start;
  assert.ok(result.ok, "scale instance should be feasible");
  assert.ok(
    elapsedMs < 30_000,
    `planning took ${elapsedMs}ms, exceeding the 30s budget`,
  );
  assert.ok(verify(input, result));

  const totalSlots = input.tasks.reduce((s, t) => s + t.requiredJudges, 0);
  assert.equal(totalSlots, 1200);
  const assigned = Object.values(result.assignments).reduce(
    (s, panel) => s + panel.length,
    0,
  );
  assert.equal(assigned, totalSlots);

  // Permuting task and judge order must not change feasibility or objectives.
  const rng = makeRng(99);
  const reordered: PlanInput = {
    judges: shuffle(input.judges, rng),
    tasks: shuffle(input.tasks, rng),
    projects: shuffle(input.projects, rng),
  };
  const again = plan(reordered);
  assert.ok(again.ok);
  assert.deepEqual(again.objectives, result.objectives);
  assert.ok(verify(reordered, again));
});
