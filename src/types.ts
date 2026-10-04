/** 新人（待分配导师的入职者） */
export interface Newcomer {
  id: string;
  department: string;
  location: string;
  interests: ReadonlySet<string>;
  /** 候选导师 ID 集合（候选资格已由调用方确认，导师均任职满六个月） */
  candidateMentorIds: ReadonlySet<string>;
}

/** 导师 */
export interface Mentor {
  id: string;
  department: string;
  location: string;
  interests: ReadonlySet<string>;
  /** 历史活跃配对数，0..3，历史配对不可移动 */
  activeMenteeCount: number;
}

/** 经理强制指定的一对配对 */
export interface ForcedAssignment {
  newcomerId: string;
  mentorId: string;
}

/** planBatch 的输入 */
export interface PlanInput {
  newcomers: Newcomer[];
  mentors: Mentor[];
  forcedAssignments: ForcedAssignment[];
}

/** 一条配对结果 */
export interface Assignment {
  newcomerId: string;
  mentorId: string;
}

/** 目标值：先最大化配对人数，再最大化总分 */
export interface Objective {
  matchedCount: number;
  totalScore: number;
}

/** planBatch 的成功结果 */
export interface BatchPlan {
  feasible: true;
  assignments: Assignment[];
  unassignedNewcomerIds: string[];
  objective: Objective;
}

/** 强制指定相互冲突（或违反候选/容量约束）时的结果 */
export interface InfeasiblePlan {
  feasible: false;
  reason: string;
}

export type PlanResult = BatchPlan | InfeasiblePlan;

/** evaluatePlan 的评估结果 */
export interface Evaluation {
  /** 方案是否合法（容量、候选关系、强制指定、每人最多一名导师） */
  valid: boolean;
  /** 不合法时的原因列表；合法时为空 */
  violations: string[];
  /** 本批配对人数（不合法时仍按可识别部分统计） */
  matchedCount: number;
  /** 每名已配对新人的重新计算得分（newcomerId -> score） */
  scores: Map<string, number>;
  /** 重新计算的总分 */
  totalScore: number;
}
