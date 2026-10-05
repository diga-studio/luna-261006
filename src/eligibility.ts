import type { PlanInput } from "./types.js";

/** Per-task derived data shared by plan and verify. */
export interface TaskModel {
  taskIndex: number;
  /** Locked judges, as judge indexes. */
  lockedJudges: number[];
  /** Declared preferred judges, as judge indexes (may include ineligible ones). */
  preferredJudges: number[];
  /** Slots still to fill after locked judges. */
  remainingNeed: number;
  /** Judge indexes eligible as candidates (locked judges excluded). */
  candidateJudges: number[];
}

export interface BatchModel {
  judgeIndexById: Map<string, number>;
  taskIndexById: Map<string, number>;
  /** Remaining capacity per judge after locked pairs. */
  remainingCapacity: number[];
  /** Locked assignment count per judge. */
  lockedCount: number[];
  tasks: TaskModel[];
}

export function buildModel(_input: PlanInput): BatchModel {
  const judgeIndexById = new Map<string, number>();
  _input.judges.forEach((judge, index) => {
    judgeIndexById.set(judge.id, index);
  });
  const taskIndexById = new Map<string, number>();
  _input.tasks.forEach((task, index) => {
    taskIndexById.set(task.id, index);
  });
  const projectById = new Map<string, PlanInput["projects"][number]>();
  for (const project of _input.projects) {
    projectById.set(project.id, project);
  }

  const judgeCount = _input.judges.length;
  const lockedCount = new Array<number>(judgeCount).fill(0);
  const lockedPerTask: number[][] = [];
  for (const task of _input.tasks) {
    const locked = task.lockedJudgeIds.map((id) => {
      const index = judgeIndexById.get(id);
      if (index === undefined) {
        throw new Error(`task ${task.id} locks unknown judge ${id}`);
      }
      lockedCount[index]! += 1;
      return index;
    });
    lockedPerTask.push(locked);
  }

  const remainingCapacity = _input.judges.map(
      (judge, index) => judge.capacity - lockedCount[index]!,
  );

  const tasks: TaskModel[] = _input.tasks.map((task, taskIndex) => {
    const project = projectById.get(task.projectId);
    if (!project) {
      throw new Error(`task ${task.id} references unknown project ${task.projectId}`);
    }
    const excluded = new Set<string>();
    excluded.add(project.creatorId);
    for (const stakeholder of project.stakeholderIds) {
      excluded.add(stakeholder);
    }
    if (task.kind === "appeal") {
      for (const round of project.history) {
        for (const judgeId of round) {
          excluded.add(judgeId);
        }
      }
    }
    const locked = lockedPerTask[taskIndex]!;
    const lockedSet = new Set(locked);
    const candidateJudges: number[] = [];
    for (let index = 0; index < judgeCount; index += 1) {
      if (lockedSet.has(index)) continue;
      if (excluded.has(_input.judges[index]!.id)) continue;
      candidateJudges.push(index);
    }
    const preferredJudges: number[] = [];
    for (const id of task.preferredJudgeIds) {
      const index = judgeIndexById.get(id);
      if (index !== undefined && !preferredJudges.includes(index)) {
        preferredJudges.push(index);
      }
    }
    return {
      taskIndex,
      lockedJudges: locked,
      preferredJudges,
      remainingNeed: task.requiredJudges - locked.length,
      candidateJudges,
    };
  });

  return {
    judgeIndexById,
    taskIndexById,
    remainingCapacity,
    lockedCount,
    tasks,
  };
}
