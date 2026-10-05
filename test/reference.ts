import { buildModel, type BatchModel } from "../src/eligibility.js";
import type { Objectives, PlanInput } from "../src/types.js";

/** Deterministic PRNG (mulberry32) for reproducible random instances. */
export function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randInt(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

export function shuffle<T>(items: T[], rng: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

export interface BruteForceResult {
  feasible: boolean;
  objectives?: Objectives;
}

function better(a: Objectives, b: Objectives): boolean {
  if (a.loadSquares !== b.loadSquares) return a.loadSquares < b.loadSquares;
  return a.unadoptedPreferences < b.unadoptedPreferences;
}

/**
 * Exhaustive reference: enumerates every complete panel assignment and
 * returns the lexicographically best objectives. Only for tiny instances.
 */
export function bruteForce(input: PlanInput): BruteForceResult {
  const model = buildModel(input);
  const declared = model.tasks.reduce(
    (sum, task) => sum + task.preferredJudges.length,
    0,
  );
  const load = input.judges.map(
    (judge, j) => judge.baseLoad + model.lockedCount[j]!,
  );
  const chosen: number[][] = model.tasks.map(() => []);
  let best: Objectives | undefined;

  const objectives = (): Objectives => {
    let loadSquares = 0;
    for (const l of load) loadSquares += l * l;
    let adopted = 0;
    model.tasks.forEach((task, t) => {
      const panel = new Set([...task.lockedJudges, ...chosen[t]!]);
      for (const judge of task.preferredJudges) {
        if (panel.has(judge)) adopted += 1;
      }
    });
    return { loadSquares, unadoptedPreferences: declared - adopted };
  };

  const visit = (t: number): void => {
    if (t === model.tasks.length) {
      const current = objectives();
      if (best === undefined || better(current, best)) best = current;
      return;
    }
    const task = model.tasks[t]!;
    const candidates = task.candidateJudges;
    const picked = chosen[t]!;
    const need = task.remainingNeed;
    const combine = (start: number): void => {
      if (picked.length === need) {
        visit(t + 1);
        return;
      }
      for (let i = start; i < candidates.length; i += 1) {
        const judge = candidates[i]!;
        if (
          load[judge]! - input.judges[judge]!.baseLoad >=
          input.judges[judge]!.capacity
        ) {
          continue;
        }
        load[judge]! += 1;
        picked.push(judge);
        combine(i + 1);
        picked.pop();
        load[judge]! -= 1;
      }
    };
    combine(0);
  };
  visit(0);

  if (best === undefined) return { feasible: false };
  return { feasible: true, objectives: best };
}

export interface RandomInstanceOptions {
  seed: number;
  judgeCount: number;
  taskCount: number;
  maxRequired: number;
  maxCapacity: number;
  maxBaseLoad: number;
  appealRatio: number;
  lockRatio: number;
  prefCount: number;
  historyRounds: number;
}

/** Generates a random small instance exercising locks, prefs and appeals. */
export function randomInstance(options: RandomInstanceOptions): PlanInput {
  const rng = makeRng(options.seed);
  const judges = Array.from({ length: options.judgeCount }, (_, i) => ({
    id: `j${i}`,
    baseLoad: randInt(rng, 0, options.maxBaseLoad),
    capacity: randInt(rng, 0, options.maxCapacity),
  }));
  const projects: PlanInput["projects"] = [];
  const tasks: PlanInput["tasks"] = [];
  const lockedSoFar = new Map<string, number>();
  for (let t = 0; t < options.taskCount; t += 1) {
    const judgeIds = judges.map((j) => j.id);
    const creatorId = judgeIds[randInt(rng, 0, judgeIds.length - 1)]!;
    const stakeholderIds = shuffle(judgeIds, rng).slice(
      0,
      randInt(rng, 0, 2),
    );
    const history: string[][] = [];
    const roundCount = randInt(rng, 0, options.historyRounds);
    for (let r = 0; r < roundCount; r += 1) {
      history.push(shuffle(judgeIds, rng).slice(0, randInt(rng, 1, 3)));
    }
    const projectId = `p${t}`;
    projects.push({ id: projectId, creatorId, stakeholderIds, history });
    const kind = rng() < options.appealRatio ? "appeal" : "normal";
    const requiredJudges = randInt(rng, 1, options.maxRequired);
    const excluded = new Set([creatorId, ...stakeholderIds]);
    if (kind === "appeal") {
      for (const round of history) {
        for (const id of round) excluded.add(id);
      }
    }
    let lockedJudgeIds: string[] = [];
    if (rng() < options.lockRatio && requiredJudges > 1) {
      const lockable = shuffle(
        judgeIds.filter((id) => {
          if (excluded.has(id)) return false;
          const judge = judges.find((j) => j.id === id)!;
          return (lockedSoFar.get(id) ?? 0) < judge.capacity;
        }),
        rng,
      );
      lockedJudgeIds = lockable.slice(
        0,
        randInt(rng, 0, Math.min(requiredJudges - 1, lockable.length)),
      );
      for (const id of lockedJudgeIds) {
        lockedSoFar.set(id, (lockedSoFar.get(id) ?? 0) + 1);
      }
    }
    const preferredJudgeIds = shuffle(judgeIds, rng).slice(
      0,
      randInt(rng, 0, options.prefCount),
    );
    tasks.push({
      id: `t${t}`,
      projectId,
      kind,
      requiredJudges,
      lockedJudgeIds,
      preferredJudgeIds,
    });
  }
  return { judges, tasks, projects };
}

export type { BatchModel };
