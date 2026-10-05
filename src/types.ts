/** A judge available in this batch. */
export interface Judge {
  id: string;
  /** Load carried into this batch (0..20). */
  baseLoad: number;
  /** Capacity for this batch (0..20), includes locked pairs. */
  capacity: number;
}

export type TaskKind = "normal" | "appeal";

/** A review task; each project has at most one task per batch. */
export interface ReviewTask {
  id: string;
  projectId: string;
  kind: TaskKind;
  /** Number of distinct judges required (1..5), including locked judges. */
  requiredJudges: number;
  /** Judges pre-assigned to this task; assumed eligible and within limits. */
  lockedJudgeIds: string[];
  /** Preferred judges; a soft objective, never an eligibility constraint. */
  preferredJudgeIds: string[];
}

/** Project metadata used for eligibility. */
export interface Project {
  id: string;
  creatorId: string;
  stakeholderIds: string[];
  /** Judge-id sets for every historical review round, oldest first. */
  history: string[][];
}

export interface PlanInput {
  judges: Judge[];
  tasks: ReviewTask[];
  projects: Project[];
}

export interface Objectives {
  /** Sum over judges of (final load)^2; final load = baseLoad + batch assignments. */
  loadSquares: number;
  /** Number of declared preferred (task, judge) pairs not used in the panel. */
  unadoptedPreferences: number;
}

export interface PlanSuccess {
  ok: true;
  /** taskId -> complete panel (locked judges included). */
  assignments: Record<string, string[]>;
  objectives: Objectives;
}

export interface DeficiencyEvidence {
  /** Non-empty set of tasks whose remaining demand exceeds attainable supply. */
  taskIds: string[];
}

export interface PlanFailure {
  ok: false;
  deficiency: DeficiencyEvidence;
}

export type PlanResult = PlanSuccess | PlanFailure;
