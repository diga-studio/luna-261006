import type { PlanInput } from "./types.js";

/**
 * Shared, normalized view of an input snapshot. Built once per plan/verify
 * call; the input is treated as immutable for the duration of a call.
 *
 * All per-task / per-judge data is indexed by position in the input arrays.
 */
export interface BatchContext {
  input: PlanInput;
  judgeIndexById: Map<string, number>;
  taskIndexById: Map<string, number>;
  /** Locked assignments per judge (across all tasks). */
  lockedCount: number[];
  /** capacity - lockedCount, per judge. */
  remainingCapacity: number[];
  /** requiredJudges - lockedJudgeIds.length, per task. */
  remainingSlots: number[];
  /** eligible[t][j]: judge j may review task t (ignores locks). */
  eligible: boolean[][];
  /** candidate[t][j]: eligible and not locked into task t. */
  candidate: boolean[][];
  /** preferred[t][j]: declared soft preference. */
  preferred: boolean[][];
  /** lockedPair[t][j]: judge j is locked into task t. */
  lockedPair: boolean[][];
}

export function buildContext(input: PlanInput): BatchContext {
  const judgeIndexById = new Map<string, number>();
  input.judges.forEach((judge, index) => {
    if (judgeIndexById.has(judge.id)) {
      throw new Error(`duplicate judge id: ${judge.id}`);
    }
    judgeIndexById.set(judge.id, index);
  });

  const taskIndexById = new Map<string, number>();
  input.tasks.forEach((task, index) => {
    if (taskIndexById.has(task.id)) {
      throw new Error(`duplicate task id: ${task.id}`);
    }
    taskIndexById.set(task.id, index);
  });

  const projectById = new Map(input.projects.map((p) => [p.id, p]));

  const judgeCount = input.judges.length;
  const taskCount = input.tasks.length;
  const lockedCount = new Array<number>(judgeCount).fill(0);
  const remainingSlots = new Array<number>(taskCount).fill(0);
  const eligible: boolean[][] = [];
  const candidate: boolean[][] = [];
  const preferred: boolean[][] = [];
  const lockedPair: boolean[][] = [];

  input.tasks.forEach((task, t) => {
    const project = projectById.get(task.projectId);
    if (!project) {
      throw new Error(`task ${task.id} references unknown project ${task.projectId}`);
    }

    const lockedRow = new Array<boolean>(judgeCount).fill(false);
    for (const judgeId of task.lockedJudgeIds) {
      const j = judgeIndexById.get(judgeId);
      if (j === undefined) {
        throw new Error(`task ${task.id} locks unknown judge ${judgeId}`);
      }
      if (lockedRow[j]) {
        throw new Error(`task ${task.id} locks judge ${judgeId} twice`);
      }
      lockedRow[j] = true;
      lockedCount[j]! += 1;
    }
    lockedPair.push(lockedRow);
    remainingSlots[t] = task.requiredJudges - task.lockedJudgeIds.length;

    const preferredRow = new Array<boolean>(judgeCount).fill(false);
    for (const judgeId of task.preferredJudgeIds) {
      const j = judgeIndexById.get(judgeId);
      if (j !== undefined) {
        preferredRow[j] = true;
      }
    }
    preferred.push(preferredRow);

    const blocked = new Set<string>([project.creatorId, ...project.stakeholderIds]);
    if (task.kind === "appeal") {
      for (const round of project.rounds) {
        for (const judgeId of round) {
          blocked.add(judgeId);
        }
      }
    }

    const eligibleRow = new Array<boolean>(judgeCount);
    const candidateRow = new Array<boolean>(judgeCount);
    input.judges.forEach((judge, j) => {
      const ok = !blocked.has(judge.id);
      eligibleRow[j] = ok;
      candidateRow[j] = ok && !lockedRow[j];
    });
    eligible.push(eligibleRow);
    candidate.push(candidateRow);
  });

  const remainingCapacity = input.judges.map(
    (judge, j) => judge.capacity - lockedCount[j]!,
  );

  return {
    input,
    judgeIndexById,
    taskIndexById,
    lockedCount,
    remainingCapacity,
    remainingSlots,
    eligible,
    candidate,
    preferred,
    lockedPair,
  };
}
