import { buildContext } from "./eligibility.js";
import type { PlanInput, PlanResult } from "./types.js";

export interface VerifyReport {
  valid: boolean;
  errors: string[];
}

/**
 * Independently re-checks a plan result against the input snapshot.
 * Never trusts the `ok` flag: success results are fully re-validated,
 * failure certificates are recomputed from scratch. Optimality itself is
 * not re-proven here.
 */
export function verify(input: PlanInput, result: PlanResult): VerifyReport {
  const errors: string[] = [];
  let ctx;
  try {
    ctx = buildContext(input);
  } catch (err) {
    return { valid: false, errors: [`invalid input: ${(err as Error).message}`] };
  }
  const { tasks, judges } = input;

  if (result.ok) {
    const assignedCount = new Array<number>(judges.length).fill(0);
    const seenTaskIds = new Set<string>();

    for (const [taskId, panel] of Object.entries(result.assignments)) {
      const t = ctx.taskIndexById.get(taskId);
      if (t === undefined) {
        errors.push(`assignment for unknown task ${taskId}`);
        continue;
      }
      seenTaskIds.add(taskId);
      const task = tasks[t]!;

      if (panel.length !== task.requiredJudges) {
        errors.push(
          `task ${taskId}: panel size ${panel.length} != required ${task.requiredJudges}`,
        );
      }
      const distinct = new Set(panel);
      if (distinct.size !== panel.length) {
        errors.push(`task ${taskId}: duplicate judges in panel`);
      }
      for (const judgeId of panel) {
        const j = ctx.judgeIndexById.get(judgeId);
        if (j === undefined) {
          errors.push(`task ${taskId}: unknown judge ${judgeId}`);
          continue;
        }
        assignedCount[j]! += 1;
        if (!ctx.eligible[t]![j]) {
          errors.push(`task ${taskId}: judge ${judgeId} is not eligible`);
        }
      }
      for (const judgeId of task.lockedJudgeIds) {
        if (!distinct.has(judgeId)) {
          errors.push(`task ${taskId}: locked judge ${judgeId} missing`);
        }
      }
    }
    for (const task of tasks) {
      if (!seenTaskIds.has(task.id)) {
        errors.push(`missing assignment for task ${task.id}`);
      }
    }

    for (let j = 0; j < judges.length; j++) {
      if (assignedCount[j]! > judges[j]!.capacity) {
        errors.push(
          `judge ${judges[j]!.id}: ${assignedCount[j]} assignments exceed capacity ${judges[j]!.capacity}`,
        );
      }
    }

    let load = 0;
    for (let j = 0; j < judges.length; j++) {
      const finalLoad = judges[j]!.baseLoad + assignedCount[j]!;
      load += finalLoad * finalLoad;
    }
    if (load !== result.objectives.load) {
      errors.push(
        `reported load objective ${result.objectives.load} != recomputed ${load}`,
      );
    }

    let unmet = 0;
    for (const task of tasks) {
      const panel = new Set(result.assignments[task.id] ?? []);
      for (const judgeId of task.preferredJudgeIds) {
        if (!panel.has(judgeId)) unmet += 1;
      }
    }
    if (unmet !== result.objectives.unmetPreferences) {
      errors.push(
        `reported unmet preferences ${result.objectives.unmetPreferences} != recomputed ${unmet}`,
      );
    }
  } else {
    const { deficiency } = result;
    const taskIds = deficiency.taskIds;
    if (taskIds.length === 0) {
      errors.push("deficiency certificate has an empty task set");
    }
    const seen = new Set<string>();
    let demand = 0;
    const member: boolean[] = new Array<boolean>(tasks.length).fill(false);
    for (const taskId of taskIds) {
      const t = ctx.taskIndexById.get(taskId);
      if (t === undefined) {
        errors.push(`deficiency references unknown task ${taskId}`);
        continue;
      }
      if (seen.has(taskId)) {
        errors.push(`deficiency lists task ${taskId} twice`);
        continue;
      }
      seen.add(taskId);
      member[t] = true;
      demand += ctx.remainingSlots[t]!;
    }

    let supply = 0;
    for (let j = 0; j < judges.length; j++) {
      let legal = 0;
      for (let t = 0; t < tasks.length; t++) {
        if (member[t]! && ctx.candidate[t]![j]) legal += 1;
      }
      supply += Math.min(ctx.remainingCapacity[j]!, legal);
    }

    if (deficiency.demand !== demand) {
      errors.push(
        `reported demand ${deficiency.demand} != recomputed ${demand}`,
      );
    }
    if (deficiency.supply !== supply) {
      errors.push(
        `reported supply ${deficiency.supply} != recomputed ${supply}`,
      );
    }
    if (demand <= supply) {
      errors.push(
        `deficiency inequality fails: demand ${demand} <= supply ${supply}`,
      );
    }
  }

  return { valid: errors.length === 0, errors };
}
