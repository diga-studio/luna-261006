/** A participant of an event. Tags are treated as a set. */
export interface ParticipantInput {
  id: string;
  tags: string[];
}

export interface EventConfig {
  participants: ParticipantInput[];
  /** Total number of rounds, at most 12. */
  rounds: number;
}

/** Result of a single round. */
export interface RoundPlan {
  /** 0-based round index. */
  round: number;
  /** Matched pairs of participant ids. */
  pairs: Array<[string, string]>;
  /** Attending participants who got no pair this round. */
  byes: string[];
}

/** Objective values of one round, useful for tests and diagnostics. */
export interface RoundObjectives {
  /** Number of pairs formed this round. */
  pairCount: number;
  /** Sum of squared cumulative bye counts after this round. */
  byeSquareSum: number;
  /** Sum of common-tag counts over all pairs of this round. */
  tagScore: number;
}
