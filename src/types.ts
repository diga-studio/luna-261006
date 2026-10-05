/** A judge available in this batch. */
export interface Judge {
  id: string;
  /** Load carried into this batch (0..20). */
  baseLoad: number;
  /** Max number of assignments this judge may receive in this batch (0..20). */
  capacity: number;
}

/** Historical record of a project. */
export interface Project {
  id: string;
  creatorId: string;
  stakeholderIds: string[];
  /** Judge ids per historical round; rounds[i] is the panel of round i. */
  rounds: string[][];
}

export type TaskKind = "normal" | "appeal";

/** A review task to staff in this batch. */
export interface ReviewTask {
  id: string;
  projectId: string;
  kind: TaskKind;
  /** Total panel size required (1..5), including locked judges. */
  requiredJudges: number;
  /** Judges pre-assigned to this task; kept as-is and consume capacity. */
  lockedJudgeIds: string[];
  /** Preferred judges; soft preference, never an eligibility constraint. */
  preferredJudgeIds: string[];
}

export interface PlanInput {
  judges: Judge[];
  tasks: ReviewTask[];
  projects: Project[];
}

/** Objective values of a complete assignment. */
export interface Objectives {
  /** Sum over judges of (baseLoad + batch assignments)^2. */
  load: number;
  /** Number of declared preferred (task, judge) pairs not used. */
  unmetPreferences: number;
}

export interface PlanSuccess {
  ok: true;
  /** taskId -> full panel (locked + assigned), size === requiredJudges. */
  assignments: Record<string, string[]>;
  objectives: Objectives;
}

/**
 * Hall-style deficiency certificate: a non-empty set S of tasks whose
 * remaining slot demand strictly exceeds the total contribution judges can
 * offer to S (see verify for the exact recomputation).
 */
export interface Deficiency {
  taskIds: string[];
  demand: number;
  supply: number;
}

export interface PlanFailure {
  ok: false;
  deficiency: Deficiency;
}

export type PlanResult = PlanSuccess | PlanFailure;
