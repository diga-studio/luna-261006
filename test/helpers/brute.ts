import { buildContext } from "../../src/eligibility.js";
import type { PlanInput } from "../../src/types.js";

export interface BruteResult {
  feasible: boolean;
  load: number;
  unmetPreferences: number;
}

/**
 * Exhaustive reference: enumerates every complete panel assignment and
 * returns the lexicographically best (load, unmetPreferences). Only for
 * small test instances.
 */
export function bruteForce(input: PlanInput): BruteResult {
  const ctx = buildContext(input);
  const { tasks, judges } = input;
  const taskCount = tasks.length;
  const judgeCount = judges.length;

  const remainingCapacity = [...ctx.remainingCapacity];
  const chosen: number[][] = tasks.map(() => []);

  let best: BruteResult = {
    feasible: false,
    load: Infinity,
    unmetPreferences: Infinity,
  };

  const score = () => {
    const count = new Array<number>(judgeCount).fill(0);
    for (let t = 0; t < taskCount; t++) {
      for (const j of chosen[t]!) count[j]! += 1;
    }
    let load = 0;
    for (let j = 0; j < judgeCount; j++) {
      const finalLoad =
        judges[j]!.baseLoad + ctx.lockedCount[j]! + count[j]!;
      load += finalLoad * finalLoad;
    }
    let unmet = 0;
    for (let t = 0; t < taskCount; t++) {
      const panel = new Set([
        ...tasks[t]!.lockedJudgeIds,
        ...chosen[t]!.map((j) => judges[j]!.id),
      ]);
      for (const judgeId of tasks[t]!.preferredJudgeIds) {
        if (!panel.has(judgeId)) unmet += 1;
      }
    }
    if (
      load < best.load ||
      (load === best.load && unmet < best.unmetPreferences)
    ) {
      best = { feasible: true, load, unmetPreferences: unmet };
    }
  };

  const pick = (t: number, start: number, left: number) => {
    if (left === 0) {
      if (t + 1 === taskCount) score();
      else assignTask(t + 1);
      return;
    }
    for (let j = start; j < judgeCount; j++) {
      if (!ctx.candidate[t]![j]) continue;
      if (remainingCapacity[j]! <= 0) continue;
      remainingCapacity[j]! -= 1;
      chosen[t]!.push(j);
      pick(t, j + 1, left - 1);
      chosen[t]!.pop();
      remainingCapacity[j]! += 1;
    }
  };

  const assignTask = (t: number) => {
    pick(t, 0, ctx.remainingSlots[t]!);
  };

  if (taskCount === 0) {
    return { feasible: true, load: 0, unmetPreferences: 0 };
  }
  assignTask(0);
  return best;
}
