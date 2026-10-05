/** Day of week, 0 = Sunday ... 6 = Saturday (director-local calendar). */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/**
 * A weekly recurring availability window in the director's local wall-clock
 * time. Half-open: [startDay/startMinute, endMinute). If endMinute <=
 * startMinute the window ends on the following day. startMinute !== endMinute.
 * Minutes are minute-of-day in [0, 1439].
 */
export interface WeeklyWindow {
  readonly startDay: Weekday;
  readonly startMinute: number;
  readonly endMinute: number;
}

/** A serving director. Identity is supplied by the caller. */
export interface Director {
  readonly id: string;
  /** IANA time zone name, e.g. "America/New_York". */
  readonly timeZone: string;
}

/** Query parameters for candidate-slot search. */
export interface CandidateQuery {
  /** UTC instant (ms since epoch) of search range start, inclusive. Must be minute-aligned. */
  readonly rangeStartMs: number;
  /** UTC instant (ms since epoch) of search range end, exclusive. Must be minute-aligned. */
  readonly rangeEndMs: number;
  /** Meeting length in whole minutes (real elapsed time). Positive integer. */
  readonly durationMinutes: number;
  /** Invited subset of director ids. Defaults to the whole roster. */
  readonly inviteeIds?: readonly string[];
  /** Integer quorum percentage of the full roster, ceil(total * pct / 100). Defaults to 60. */
  readonly quorumPercent?: number;
}

/**
 * A maximal run of consecutive valid start minutes. Both bounds are
 * themselves valid start minutes (inclusive).
 */
export interface CandidateInterval {
  /** First valid meeting start minute (UTC ms, minute-aligned), inclusive. */
  readonly firstStartMs: number;
  /** Last valid meeting start minute (UTC ms, minute-aligned), inclusive. */
  readonly lastStartMs: number;
}
