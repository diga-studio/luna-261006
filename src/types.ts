/** A participant of an activity. Tags are treated as a set. */
export interface Participant {
  id: string;
  tags: string[];
}

/** One matched 1:1 pair in a round. */
export interface MatchPair {
  a: string;
  b: string;
  /** Common interest tags shared by a and b (non-empty by construction). */
  commonTags: string[];
}

/** Result of a single round: matched pairs and attendees left without a pair (byes). */
export interface RoundResult {
  /** 0-based round index. */
  round: number;
  pairs: MatchPair[];
  /** Attendees of this round who were not matched. Absent participants are not listed. */
  byes: string[];
}
