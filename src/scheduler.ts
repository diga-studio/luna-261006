import { weeklyWindowsToUtcIntervals } from "./availability.js";
import type {
  CandidateInterval,
  CandidateQuery,
  Director,
  WeeklyWindow,
  Weekday,
} from "./types.js";

const MINUTE_MS = 60_000;
const DAY_MIN = 24 * 60;
const DEFAULT_QUORUM_PERCENT = 60;

function assertMinuteAligned(ms: number, name: string): void {
  if (!Number.isFinite(ms) || ms % MINUTE_MS !== 0) {
    throw new RangeError(`${name} must be a finite, minute-aligned epoch ms`);
  }
}

function validateWindows(windows: readonly WeeklyWindow[]): void {
  for (const win of windows) {
    const dayOk =
      Number.isInteger(win.startDay) && win.startDay >= 0 && win.startDay <= 6;
    const minutesOk =
      Number.isInteger(win.startMinute) &&
      Number.isInteger(win.endMinute) &&
      win.startMinute >= 0 &&
      win.startMinute < DAY_MIN &&
      win.endMinute >= 0 &&
      win.endMinute < DAY_MIN;
    if (!dayOk || !minutesOk) {
      throw new RangeError(
        "window startDay must be 0-6 and minutes must be integers in [0, 1439]",
      );
    }
    if (win.startMinute === win.endMinute) {
      throw new RangeError("window start and end minutes must differ");
    }
  }
}

function validateTimeZone(timeZone: string): void {
  // Throws RangeError for unknown IANA names.
  new Intl.DateTimeFormat("en-US", { timeZone });
}

/**
 * In-memory board-meeting scheduler. Not persistent; configuration is
 * expected to change only between queries. Calls are serial.
 */
export class BoardScheduler {
  #roster = new Map<string, Director>();
  #availability = new Map<string, readonly WeeklyWindow[]>();

  /** Replace the serving-director roster. */
  setRoster(directors: readonly Director[]): void {
    const next = new Map<string, Director>();
    for (const director of directors) {
      if (next.has(director.id)) {
        throw new Error(`duplicate director id: ${director.id}`);
      }
      validateTimeZone(director.timeZone);
      next.set(director.id, {
        id: director.id,
        timeZone: director.timeZone,
      });
    }
    this.#roster = next;
  }

  /** Replace one director's weekly availability windows. */
  setWeeklyAvailability(
    directorId: string,
    windows: readonly WeeklyWindow[],
  ): void {
    validateWindows(windows);
    this.#availability.set(directorId, [...windows]);
  }

  /**
   * Find every valid meeting start minute in the search range, compressed
   * into maximal consecutive intervals. Empty when nothing qualifies.
   */
  findCandidates(query: CandidateQuery): CandidateInterval[] {
    assertMinuteAligned(query.rangeStartMs, "rangeStartMs");
    assertMinuteAligned(query.rangeEndMs, "rangeEndMs");
    if (query.rangeEndMs <= query.rangeStartMs) {
      throw new RangeError("rangeEndMs must be after rangeStartMs");
    }
    if (
      !Number.isInteger(query.durationMinutes) ||
      query.durationMinutes <= 0
    ) {
      throw new RangeError("durationMinutes must be a positive integer");
    }
    const quorumPercent = query.quorumPercent ?? DEFAULT_QUORUM_PERCENT;
    if (
      !Number.isInteger(quorumPercent) ||
      quorumPercent < 1 ||
      quorumPercent > 100
    ) {
      throw new RangeError("quorumPercent must be an integer in [1, 100]");
    }

    const rosterSize = this.#roster.size;
    if (rosterSize === 0) return [];
    const quorum = Math.ceil((rosterSize * quorumPercent) / 100);

    const inviteeIds = query.inviteeIds ?? [...this.#roster.keys()];
    const invitees: Director[] = [];
    for (const id of inviteeIds) {
      const director = this.#roster.get(id);
      if (director === undefined) {
        throw new Error(`invitee is not on the roster: ${id}`);
      }
      invitees.push(director);
    }

    const searchStartMin = query.rangeStartMs / MINUTE_MS;
    const searchEndMin = query.rangeEndMs / MINUTE_MS;
    const lastStartMin = searchEndMin - query.durationMinutes;
    if (lastStartMin < searchStartMin) return [];

    // Sweep-line over per-director feasible start-minute ranges.
    const deltas = new Map<number, number>();
    const bump = (at: number, delta: number): void => {
      deltas.set(at, (deltas.get(at) ?? 0) + delta);
    };
    for (const director of invitees) {
      const windows = this.#availability.get(director.id) ?? [];
      const intervals = weeklyWindowsToUtcIntervals(
        director.timeZone,
        windows,
        searchStartMin,
        searchEndMin,
      );
      for (const iv of intervals) {
        // Meeting [t, t+duration) must fit inside [iv.startMin, iv.endMin).
        const from = Math.max(iv.startMin, searchStartMin);
        const to = Math.min(iv.endMin - query.durationMinutes, lastStartMin);
        if (to >= from) {
          bump(from, 1);
          bump(to + 1, -1);
        }
      }
    }

    const eventMinutes = [...deltas.keys()].sort((a, b) => a - b);
    const result: CandidateInterval[] = [];
    let count = 0;
    let pos = searchStartMin;
    let runStart = -1;
    const closeRun = (lastMin: number): void => {
      if (runStart >= 0) {
        result.push({
          firstStartMs: runStart * MINUTE_MS,
          lastStartMs: lastMin * MINUTE_MS,
        });
        runStart = -1;
      }
    };
    const cover = (fromMin: number, toMin: number): void => {
      // Minutes [fromMin, toMin] share the current attendee count.
      if (toMin < fromMin) return;
      if (count >= quorum) {
        if (runStart < 0) runStart = fromMin;
      } else {
        closeRun(fromMin - 1);
      }
    };
    for (const minute of eventMinutes) {
      if (minute > lastStartMin + 1) break;
      cover(pos, Math.min(minute - 1, lastStartMin));
      if (minute > lastStartMin) {
        pos = minute;
        break;
      }
      count += deltas.get(minute)!;
      pos = minute;
    }
    if (pos <= lastStartMin) cover(pos, lastStartMin);
    closeRun(lastStartMin);
    return result;
  }
}
