import { buildContext } from "./eligibility.js";
import { MinCostFlow, type FlowEdge } from "./mincostflow.js";
import type { PlanInput, PlanResult } from "./types.js";

/**
 * Lexicographic scale factor: primary (load) costs are multiples of BIG,
 * secondary (unused preference) costs are 0/1 per pair and their total is
 * bounded by the number of assigned pairs (<= sum of requiredJudges), which
 * is always far below BIG. All totals stay far below 2^53.
 */
const BIG = 1_000_000;

export function plan(input: PlanInput): PlanResult {
  const ctx = buildContext(input);
  const { tasks, judges } = input;
  const taskCount = tasks.length;
  const judgeCount = judges.length;

  for (let t = 0; t < taskCount; t++) {
    if (ctx.remainingSlots[t]! < 0) {
      throw new Error(
        `task ${tasks[t]!.id} locks more judges than it requires`,
      );
    }
  }
  for (let j = 0; j < judgeCount; j++) {
    if (ctx.remainingCapacity[j]! < 0) {
      throw new Error(
        `judge ${judges[j]!.id} is locked into more tasks than capacity allows`,
      );
    }
  }

  const source = 0;
  const taskNode = (t: number) => 1 + t;
  const judgeNode = (j: number) => 1 + taskCount + j;
  const sink = 1 + taskCount + judgeCount;

  const flow = new MinCostFlow();
  for (let i = 0; i <= sink; i++) flow.addNode();

  let totalSlots = 0;
  for (let t = 0; t < taskCount; t++) {
    const slots = ctx.remainingSlots[t]!;
    totalSlots += slots;
    if (slots > 0) flow.addEdge(source, taskNode(t), slots, 0);
  }

  const pairEdges: Array<{ t: number; j: number; edge: FlowEdge }> = [];
  for (let t = 0; t < taskCount; t++) {
    for (let j = 0; j < judgeCount; j++) {
      if (!ctx.candidate[t]![j]) continue;
      const secondary = ctx.preferred[t]![j] ? 0 : 1;
      const edge = flow.addEdge(taskNode(t), judgeNode(j), 1, secondary);
      pairEdges.push({ t, j, edge });
    }
  }

  for (let j = 0; j < judgeCount; j++) {
    const startLoad = judges[j]!.baseLoad + ctx.lockedCount[j]!;
    const room = ctx.remainingCapacity[j]!;
    for (let k = 1; k <= room; k++) {
      const marginal = 2 * (startLoad + k) - 1;
      flow.addEdge(judgeNode(j), sink, 1, BIG * marginal);
    }
  }

  const [sent] = flow.solve(source, sink, totalSlots);

  if (sent < totalSlots) {
    const reach = flow.reachableFrom(source);
    const deficientTasks: number[] = [];
    for (let t = 0; t < taskCount; t++) {
      if (reach[taskNode(t)]!) deficientTasks.push(t);
    }
    let demand = 0;
    for (const t of deficientTasks) demand += ctx.remainingSlots[t]!;
    let supply = 0;
    for (let j = 0; j < judgeCount; j++) {
      let legal = 0;
      for (const t of deficientTasks) {
        if (ctx.candidate[t]![j]) legal += 1;
      }
      supply += Math.min(ctx.remainingCapacity[j]!, legal);
    }
    return {
      ok: false,
      deficiency: {
        taskIds: deficientTasks.map((t) => tasks[t]!.id),
        demand,
        supply,
      },
    };
  }

  const assignments: Record<string, string[]> = {};
  for (let t = 0; t < taskCount; t++) {
    assignments[tasks[t]!.id] = [...tasks[t]!.lockedJudgeIds];
  }
  const chosen = new Array<number>(judgeCount).fill(0);
  for (const { t, j, edge } of pairEdges) {
    if (edge.cap === 0) {
      assignments[tasks[t]!.id]!.push(judges[j]!.id);
      chosen[j]! += 1;
    }
  }

  let load = 0;
  for (let j = 0; j < judgeCount; j++) {
    const finalLoad = judges[j]!.baseLoad + ctx.lockedCount[j]! + chosen[j]!;
    load += finalLoad * finalLoad;
  }

  let unmetPreferences = 0;
  for (let t = 0; t < taskCount; t++) {
    const panel = new Set(assignments[tasks[t]!.id]);
    for (const judgeId of tasks[t]!.preferredJudgeIds) {
      if (!panel.has(judgeId)) unmetPreferences += 1;
    }
  }

  return {
    ok: true,
    assignments,
    objectives: { load, unmetPreferences },
  };
}
