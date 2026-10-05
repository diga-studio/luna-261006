import { buildModel } from "./eligibility.js";
import { MinCostFlow } from "./mincostflow.js";
import type { PlanInput, PlanResult } from "./types.js";

/**
 * Cost multiplier separating the two lexicographic objectives. The secondary
 * objective (non-preferred assignments) never exceeds the total slot count,
 * which is bounded well below this factor.
 */
const LOAD_COST_SCALE = 1_000_000;

export function plan(_input: PlanInput): PlanResult {
  const model = buildModel(_input);
  const taskCount = model.tasks.length;
  const judgeCount = _input.judges.length;
  const source = 0;
  const taskNode = (t: number): number => 1 + t;
  const judgeNode = (j: number): number => 1 + taskCount + j;
  const sink = 1 + taskCount + judgeCount;

  const flow = new MinCostFlow(sink + 1);
  let totalNeed = 0;
  for (const task of model.tasks) {
    if (task.remainingNeed > 0) {
      flow.addEdge(source, taskNode(task.taskIndex), task.remainingNeed, 0);
      totalNeed += task.remainingNeed;
    }
  }
  // Candidate edges: cost 0 for preferred judges, 1 otherwise. With a fixed
  // total flow, minimizing non-preferred assignments maximizes adopted
  // preferences, i.e. minimizes unadopted preferences.
  const candidateEdges: Array<{ task: number; judge: number; edge: number }> = [];
  for (const task of model.tasks) {
    const preferred = new Set(task.preferredJudges);
    for (const judge of task.candidateJudges) {
      const cost = preferred.has(judge) ? 0 : 1;
      const edge = flow.addEdge(taskNode(task.taskIndex), judgeNode(judge), 1, cost);
      candidateEdges.push({ task: task.taskIndex, judge, edge });
    }
  }
  // Convex load cost: the k-th unit assigned to a judge costs
  // (base+locked+k)^2 - (base+locked+k-1)^2, so the per-judge total telescopes
  // into the squared final load.
  for (let j = 0; j < judgeCount; j += 1) {
    const start = _input.judges[j]!.baseLoad + model.lockedCount[j]!;
    for (let k = 1; k <= model.remainingCapacity[j]!; k += 1) {
      const unitCost = 2 * (start + k) - 1;
      flow.addEdge(judgeNode(j), sink, 1, unitCost * LOAD_COST_SCALE);
    }
  }

  const { flow: pushed } = flow.solve(source, sink);

  if (pushed < totalNeed) {
    const reachable = flow.reachableFrom(source);
    const deficient: number[] = [];
    for (const task of model.tasks) {
      if (task.remainingNeed > 0 && reachable[taskNode(task.taskIndex)]!) {
        deficient.push(task.taskIndex);
      }
    }
    return {
      ok: false,
      deficiency: {
        taskIds: deficient.map((t) => _input.tasks[t]!.id),
      },
    };
  }

  const assignedByTask: string[][] = model.tasks.map((task) =>
    task.lockedJudges.map((j) => _input.judges[j]!.id),
  );
  const assignedCount = new Array<number>(judgeCount).fill(0);
  for (const { task, judge, edge } of candidateEdges) {
    if (flow.flowOn(taskNode(task), edge) > 0) {
      assignedByTask[task]!.push(_input.judges[judge]!.id);
      assignedCount[judge]! += 1;
    }
  }

  let loadSquares = 0;
  for (let j = 0; j < judgeCount; j += 1) {
    const finalLoad =
      _input.judges[j]!.baseLoad + model.lockedCount[j]! + assignedCount[j]!;
    loadSquares += finalLoad * finalLoad;
  }
  let adopted = 0;
  let declared = 0;
  for (const task of model.tasks) {
    declared += task.preferredJudges.length;
    const panel = new Set(assignedByTask[task.taskIndex]);
    for (const judge of task.preferredJudges) {
      if (panel.has(_input.judges[judge]!.id)) adopted += 1;
    }
  }

  const assignments: Record<string, string[]> = {};
  model.tasks.forEach((task) => {
    assignments[_input.tasks[task.taskIndex]!.id] = assignedByTask[task.taskIndex]!;
  });
  return {
    ok: true,
    assignments,
    objectives: {
      loadSquares,
      unadoptedPreferences: declared - adopted,
    },
  };
}
