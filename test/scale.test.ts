import { describe, expect, it } from "vitest";
import {
  plan,
  verify,
  type PlanInput,
  type Project,
  type TaskKind,
} from "../src/index.js";
import { buildContext } from "../src/eligibility.js";
import { randInt, rng, shuffle } from "./helpers/generator.js";

const TASKS = 300;
const JUDGES = 200;
const PER_TASK = 4; // 1200 slots total

/**
 * Deterministic large instance with a guaranteed feasible "hidden"
 * assignment, plus locked pairs and preferences. Eligibility conflicts
 * (creators, stakeholders, appeal history) keep candidate pairs <= 60000.
 */
function largeInput(seed: number): PlanInput {
  const rand = rng(seed);
  const judges = Array.from({ length: JUDGES }, (_, i) => ({
    id: `j${i}`,
    baseLoad: randInt(rand, 0, 20),
    capacity: randInt(rand, 8, 12),
  }));

  const projects: Project[] = [];
  const kinds: TaskKind[] = [];
  const blockedPerTask: Set<string>[] = [];
  for (let t = 0; t < TASKS; t++) {
    const creator = `j${randInt(rand, 0, JUDGES - 1)}`;
    const stakeholderIds = new Set<string>();
    while (stakeholderIds.size < 2) {
      stakeholderIds.add(`j${randInt(rand, 0, JUDGES - 1)}`);
    }
    stakeholderIds.delete(creator);
    const kind: TaskKind = rand() < 0.3 ? "appeal" : "normal";
    kinds.push(kind);
    const rounds =
      kind === "appeal"
        ? [
            Array.from(
              { length: 3 },
              () => `j${randInt(rand, 0, JUDGES - 1)}`,
            ),
            Array.from(
              { length: 3 },
              () => `j${randInt(rand, 0, JUDGES - 1)}`,
            ),
          ]
        : [];
    projects.push({
      id: `p${t}`,
      creatorId: creator,
      stakeholderIds: [...stakeholderIds],
      rounds,
    });
    const blocked = new Set([creator, ...stakeholderIds]);
    for (const round of rounds) for (const id of round) blocked.add(id);
    blockedPerTask.push(blocked);
  }

  // Hidden feasible assignment: greedy least-loaded among eligible judges.
  const load = new Array<number>(JUDGES).fill(0);
  const hidden: string[][] = [];
  for (let t = 0; t < TASKS; t++) {
    const eligible = judges
      .map((j, idx) => ({ j, idx }))
      .filter(
        ({ j, idx }) =>
          !blockedPerTask[t]!.has(j.id) && load[idx]! < j.capacity,
      )
      .sort((a, b) => load[a.idx]! - load[b.idx]!);
    expect(eligible.length).toBeGreaterThanOrEqual(PER_TASK);
    const picked = eligible.slice(0, PER_TASK).map(({ j }) => j.id);
    for (const id of picked) load[Number(id.slice(1))]! += 1;
    hidden.push(picked);
  }

  const tasks = projects.map((project, t) => {
    const lockedCount = rand() < 0.5 ? 1 : 0;
    const lockedJudgeIds = hidden[t]!.slice(0, lockedCount);
    const preferredJudgeIds = [
      ...hidden[t]!.slice(0, 2),
      `j${randInt(rand, 0, JUDGES - 1)}`,
      `j${randInt(rand, 0, JUDGES - 1)}`,
    ];
    return {
      id: `t${t}`,
      projectId: project.id,
      kind: kinds[t]!,
      requiredJudges: PER_TASK,
      lockedJudgeIds,
      preferredJudgeIds: [...new Set(preferredJudgeIds)],
    };
  });

  return { judges, tasks, projects };
}

function candidatePairCount(input: PlanInput): number {
  const ctx = buildContext(input);
  let count = 0;
  for (const row of ctx.candidate) {
    for (const ok of row) if (ok) count++;
  }
  return count;
}

describe("scale", () => {
  it(
    "plans 300 tasks / 200 judges / 1200 slots with locks and preferences",
    () => {
      const input = largeInput(42);
      const pairCount = candidatePairCount(input);
      expect(pairCount).toBeLessThanOrEqual(60_000);
      const slots = input.tasks.reduce(
        (sum, task) => sum + task.requiredJudges,
        0,
      );
      expect(slots).toBe(1200);
      expect(input.tasks.some((t) => t.lockedJudgeIds.length > 0)).toBe(true);
      expect(input.tasks.some((t) => t.preferredJudgeIds.length > 0)).toBe(
        true,
      );

      const start = Date.now();
      const result = plan(input);
      const elapsedMs = Date.now() - start;
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(elapsedMs).toBeLessThan(30_000);

      const report = verify(input, result);
      expect(report.errors).toEqual([]);
      expect(report.valid).toBe(true);

      // Reordering tasks and judges must not change feasibility or objectives.
      const reordered: PlanInput = {
        judges: shuffle(rng(7), input.judges),
        tasks: shuffle(rng(8), input.tasks),
        projects: shuffle(rng(9), input.projects),
      };
      const result2 = plan(reordered);
      expect(result2.ok).toBe(true);
      if (!result2.ok) return;
      expect(result2.objectives).toEqual(result.objectives);
      expect(verify(reordered, result2).valid).toBe(true);
    },
    120_000,
  );
});
