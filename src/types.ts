/** A new hire to be matched in this batch. */
export interface Newcomer {
  id: string;
  department: string;
  location: string;
  interests: ReadonlySet<string>;
  /** Mentors this newcomer may be assigned to (pre-vetted by caller). */
  candidateMentorIds: readonly string[];
}

/** A mentor available in this batch. */
export interface Mentor {
  id: string;
  department: string;
  location: string;
  interests: ReadonlySet<string>;
  /** Historical active matchings, 0..3. Historical matches cannot be moved. */
  historicalActive: number;
}

/** A manager-mandated pairing that must be preserved. */
export interface ForcedPair {
  newcomerId: string;
  mentorId: string;
}

export interface BatchInput {
  newcomers: readonly Newcomer[];
  mentors: readonly Mentor[];
  forced: readonly ForcedPair[];
}

export interface Assignment {
  newcomerId: string;
  mentorId: string;
}

/** Result of planBatch. */
export interface PlanResult {
  /** False when forced pairs conflict so no feasible plan exists. */
  feasible: boolean;
  /** Reason when feasible is false. */
  reason?: string;
  assignments: Assignment[];
  unassignedNewcomerIds: string[];
  /** Number of newcomers matched in this batch (including forced). */
  matchedCount: number;
  /** Score per matched newcomer id, recomputed with final loads. */
  scores: Record<string, number>;
  /** Sum of scores over this batch's matched newcomers. */
  totalScore: number;
}

/** Result of evaluatePlan. */
export interface EvaluationResult {
  valid: boolean;
  violations: string[];
  matchedCount: number;
  scores: Record<string, number>;
  totalScore: number;
}
