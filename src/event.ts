import { buildSchedulerState, planRound, SchedulerState } from "./scheduler.js";
import type { Participant, RoundResult } from "./types.js";

const MAX_ROUNDS = 12;

/**
 * An activity event: a fixed participant roster, up to 12 rounds of
 * interest-based 1:1 matching. All state lives in process memory.
 *
 * Only confirmed rounds form the official history. Generating a schedule
 * is tentative: it never mutates history, and re-generating always starts
 * from confirmed state only.
 */
export class ActivityEvent {
  private readonly state: SchedulerState;
  private readonly indexById: Map<string, number>;
  private readonly totalRounds: number;
  /** Attendance per round (participant indices). Defaults to everyone. */
  private attendance: number[][];
  /** Confirmed rounds (official history). */
  private confirmed: RoundResult[] = [];
  /** Pairs that met in confirmed rounds: key i * n + j with i < j. */
  private pairedHistory = new Set<number>();
  /** Cumulative bye counts from confirmed rounds only. */
  private byeCounts: number[];
  /** Current tentative plan for rounds confirmed.length .. totalRounds-1. */
  private plan: RoundResult[] = [];
  private planDirty = true;

  constructor(participants: Participant[], totalRounds: number) {
    if (!Array.isArray(participants) || participants.length === 0) {
      throw new Error("participants must be a non-empty array");
    }
    if (!Number.isInteger(totalRounds) || totalRounds < 1 || totalRounds > MAX_ROUNDS) {
      throw new Error(`totalRounds must be an integer in [1, ${MAX_ROUNDS}]`);
    }
    const ids = new Set<string>();
    for (const p of participants) {
      if (!p || typeof p.id !== "string" || p.id.length === 0) {
        throw new Error("each participant needs a non-empty string id");
      }
      if (ids.has(p.id)) throw new Error(`duplicate participant id: ${p.id}`);
      ids.add(p.id);
      if (!Array.isArray(p.tags)) throw new Error(`tags of ${p.id} must be an array`);
    }
    this.state = buildSchedulerState(participants);
    this.indexById = new Map(this.state.ids.map((id, i) => [id, i]));
    this.totalRounds = totalRounds;
    const everyone = this.state.ids.map((_, i) => i);
    this.attendance = Array.from({ length: totalRounds }, () => everyone.slice());
    this.byeCounts = new Array<number>(this.state.ids.length).fill(0);
  }

  /**
   * (Re)generates the tentative schedule for all unconfirmed rounds.
   * If attendance is given, it must have one entry per round of the event
   * (0-based); entries for already-confirmed rounds are ignored and cannot
   * change history. Returns the tentative rounds (unconfirmed rounds only).
   */
  generateSchedule(attendance?: string[][]): RoundResult[] {
    if (attendance !== undefined) {
      if (!Array.isArray(attendance) || attendance.length !== this.totalRounds) {
        throw new Error(`attendance must have exactly ${this.totalRounds} entries`);
      }
      for (let r = this.confirmed.length; r < this.totalRounds; r++) {
        this.attendance[r] = this.toIndices(attendance[r], `attendance[${r}]`);
      }
    }
    this.planDirty = true;
    return this.ensurePlan().map(cloneRound);
  }

  /**
   * Confirms that the next unconfirmed round happened exactly as currently
   * scheduled, making it part of the official history. Returns the
   * confirmed round. Throws if every round is already confirmed.
   */
  confirmNextRound(): RoundResult {
    if (this.confirmed.length >= this.totalRounds) {
      throw new Error("all rounds are already confirmed");
    }
    const plan = this.ensurePlan();
    const round = plan[0];
    const n = this.state.ids.length;
    for (const pair of round.pairs) {
      const i = this.indexById.get(pair.a)!;
      const j = this.indexById.get(pair.b)!;
      this.pairedHistory.add(i < j ? i * n + j : j * n + i);
    }
    for (const id of round.byes) {
      this.byeCounts[this.indexById.get(id)!]++;
    }
    this.confirmed.push(round);
    this.plan = plan.slice(1);
    return cloneRound(round);
  }

  /**
   * Replaces the attendance list of a future (unconfirmed) round and
   * re-plans all unconfirmed rounds. Confirmed rounds are untouched.
   */
  updateAttendance(round: number, attendees: string[]): RoundResult[] {
    if (!Number.isInteger(round) || round < 0 || round >= this.totalRounds) {
      throw new Error(`round must be an integer in [0, ${this.totalRounds})`);
    }
    if (round < this.confirmed.length) {
      throw new Error(`round ${round} is already confirmed and cannot be modified`);
    }
    this.attendance[round] = this.toIndices(attendees, `attendees of round ${round}`);
    this.planDirty = true;
    return this.ensurePlan().map(cloneRound);
  }

  /** Current tentative schedule for the unconfirmed rounds. */
  getSchedule(): RoundResult[] {
    return this.ensurePlan().map(cloneRound);
  }

  /** Confirmed rounds (official history), in order. */
  getConfirmedRounds(): RoundResult[] {
    return this.confirmed.map(cloneRound);
  }

  /** Cumulative bye counts from confirmed rounds, by participant id. */
  getByeCounts(): Record<string, number> {
    const out: Record<string, number> = {};
    this.state.ids.forEach((id, i) => {
      out[id] = this.byeCounts[i];
    });
    return out;
  }

  private toIndices(list: string[], what: string): number[] {
    if (!Array.isArray(list)) throw new Error(`${what} must be an array of participant ids`);
    const seen = new Set<number>();
    const out: number[] = [];
    for (const id of list) {
      const idx = this.indexById.get(id);
      if (idx === undefined) throw new Error(`unknown participant id in ${what}: ${id}`);
      if (seen.has(idx)) throw new Error(`duplicate participant id in ${what}: ${id}`);
      seen.add(idx);
      out.push(idx);
    }
    return out;
  }

  private ensurePlan(): RoundResult[] {
    if (!this.planDirty && this.plan.length === this.totalRounds - this.confirmed.length) {
      return this.plan;
    }
    const n = this.state.ids.length;
    const paired = new Set<number>(this.pairedHistory);
    const byes = this.byeCounts.slice();
    const isPaired = (i: number, j: number) => paired.has(i * n + j);
    const plan: RoundResult[] = [];
    for (let r = this.confirmed.length; r < this.totalRounds; r++) {
      const { result, pairIndices } = planRound(this.state, r, this.attendance[r], isPaired, byes);
      for (const [i, j] of pairIndices) paired.add(i * n + j);
      for (const id of result.byes) byes[this.indexById.get(id)!]++;
      plan.push(result);
    }
    this.plan = plan;
    this.planDirty = false;
    return this.plan;
  }
}

function cloneRound(r: RoundResult): RoundResult {
  return {
    round: r.round,
    pairs: r.pairs.map((p) => ({ a: p.a, b: p.b, commonTags: p.commonTags.slice() })),
    byes: r.byes.slice(),
  };
}
