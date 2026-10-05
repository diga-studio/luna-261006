import { buildModel } from "./eligibility.js";
import type { PlanInput, PlanResult } from "./types.js";

export function verify(_input: PlanInput, _result: PlanResult): boolean {
  const model = buildModel(_input);
  if (_result.ok) {
    return verifySuccess(_input, model, _result);
  }
  return verifyDeficiency(_input, model, _result.deficiency.taskIds);
}

function verifySuccess(
  input: PlanInput,
  model: ReturnType<typeof buildModel>,
  result: Extract<PlanResult, { ok: true }>,
): boolean {
  const taskIds = Object.keys(result.assignments);
  if (taskIds.length !== input.tasks.length) return false;

  const panelCount = new Array<number>(input.judges.length).fill(0);
  for (const task of model.tasks) {
    const taskId = input.tasks[task.taskIndex]!.id;
    const panel = result.assignments[taskId];
    if (!Array.isArray(panel)) return false;
    if (panel.length !== input.tasks[task.taskIndex]!.requiredJudges) return false;
    const members = new Set(panel);
    if (members.size !== panel.length) return false;
    const eligible = new Set(task.candidateJudges);
    for (const judgeId of panel) {
      const judge = model.judgeIndexById.get(judgeId);
      if (judge === undefined) return false;
      // Locked pairs are assumed eligible by contract; every other panel
      // member must be an eligible candidate for this task.
      if (!task.lockedJudges.includes(judge) && !eligible.has(judge)) {
        return false;
      }
      panelCount[judge]! += 1;
    }
    for (const locked of task.lockedJudges) {
      if (!members.has(input.judges[locked]!.id)) return false;
    }
  }
  for (let j = 0; j < input.judges.length; j += 1) {
    if (panelCount[j]! > input.judges[j]!.capacity) return false;
  }

  let loadSquares = 0;
  for (let j = 0; j < input.judges.length; j += 1) {
    const finalLoad = input.judges[j]!.baseLoad + panelCount[j]!;
    loadSquares += finalLoad * finalLoad;
  }
  if (loadSquares !== result.objectives.loadSquares) return false;

  let declared = 0;
  let adopted = 0;
  for (const task of model.tasks) {
    declared += task.preferredJudges.length;
    const panel = new Set(result.assignments[input.tasks[task.taskIndex]!.id]);
    for (const judge of task.preferredJudges) {
      if (panel.has(input.judges[judge]!.id)) adopted += 1;
    }
  }
  if (declared - adopted !== result.objectives.unadoptedPreferences) {
    return false;
  }
  return true;
}

function verifyDeficiency(
  input: PlanInput,
  model: ReturnType<typeof buildModel>,
  taskIds: string[],
): boolean {
  if (taskIds.length === 0) return false;
  const chosen = new Set<number>();
  for (const id of taskIds) {
    const index = model.taskIndexById.get(id);
    if (index === undefined || chosen.has(index)) return false;
    chosen.add(index);
  }
  let remainingSlots = 0;
  for (const index of chosen) {
    remainingSlots += model.tasks[index]!.remainingNeed;
  }
  let contribution = 0;
  for (let j = 0; j < input.judges.length; j += 1) {
    let usable = 0;
    for (const index of chosen) {
      if (model.tasks[index]!.candidateJudges.includes(j)) usable += 1;
    }
    contribution += Math.min(model.remainingCapacity[j]!, usable);
  }
  return remainingSlots > contribution;
}
