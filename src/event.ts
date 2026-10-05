import { maxWeightMatching } from "./matching";
import type {
  EventConfig,
  RoundObjectives,
  RoundPlan,
} from "./types";

const MAX_ROUNDS = 12;

function popcount32(x: number): number {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return (x * 0x01010101) >>> 24;
}

/**
 * A single event. Holds participant data, confirmed history and the
 * current (unconfirmed) plan. All state lives in process memory.
 *
 * Objectives per round are lexicographic:
 *   1. maximize the number of pairs;
 *   2. minimize the sum of squared cumulative bye counts;
 *   3. maximize the sum of common-tag counts over the round's pairs.
 * They are encoded into a single integer edge weight with sufficient
 * separation, so an exact maximum-weight matching optimizes all three.
 */
export class MatchingEvent {
  private readonly ids: string[];
  private readonly indexOf = new Map<string, number>();
  private readonly rounds: number;
  /** Common-tag count per ordered pair, row-major n*n. */
  private readonly common: Uint8Array;
  private readonly tagLo: Uint32Array;
  private readonly tagHi: Uint32Array;

  private confirmed: RoundPlan[] = [];
  private confirmedObjectives: RoundObjectives[] = [];
  /** Pair keys (i*n+j, i<j) used in confirmed rounds. */
  private confirmedPairs = new Set<number>();
  /** Cumulative bye count per participant, confirmed rounds only. */
  private confirmedByes: Int32Array;

  private planned: RoundPlan[] = [];
  private plannedObjectives: RoundObjectives[] = [];

  constructor(config: EventConfig) {
    if (!Number.isInteger(config.rounds) || config.rounds < 1 || config.rounds > MAX_ROUNDS) {
      throw new Error(`rounds must be an integer between 1 and ${MAX_ROUNDS}`);
    }
    this.rounds = config.rounds;
    this.ids = config.participants.map((p) => p.id);
    const n = this.ids.length;
    for (let i = 0; i < n; i++) {
      if (this.indexOf.has(this.ids[i]!)) {
        throw new Error(`duplicate participant id: ${this.ids[i]}`);
      }
      this.indexOf.set(this.ids[i]!, i);
    }
    // Tag universe -> 64-bit mask split into two 32-bit halves.
    const tagIndex = new Map<string, number>();
    this.tagLo = new Uint32Array(n);
    this.tagHi = new Uint32Array(n);
    config.participants.forEach((p, i) => {
      for (const tag of p.tags) {
        let t = tagIndex.get(tag);
        if (t === undefined) {
          t = tagIndex.size;
          if (t >= 64) throw new Error("at most 64 distinct interest tags are supported");
          tagIndex.set(tag, t);
        }
        if (t < 32) this.tagLo[i]! |= 1 << t;
        else this.tagHi[i]! |= 1 << (t - 32);
      }
    });
    this.common = new Uint8Array(n * n);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const c =
          popcount32((this.tagLo[i]! & this.tagLo[j]!) | 0) +
          popcount32((this.tagHi[i]! & this.tagHi[j]!) | 0);
        this.common[i * n + j] = c;
        this.common[j * n + i] = c;
      }
    }
    this.confirmedByes = new Int32Array(n);
  }

  /**
   * (Re)generate the plan for all rounds after the last confirmed one.
   * `attendance[i]` lists participant ids attending round
   * `confirmedCount + i`; its length must equal the number of remaining
   * rounds. Discards any previous unconfirmed plan; confirmed history is
   * always preserved. Generating does not mutate confirmed state, and
   * repeated calls never accumulate history.
   */
  generateSchedule(attendance: string[][]): RoundPlan[] {
    const remaining = this.rounds - this.confirmed.length;
    if (attendance.length !== remaining) {
      throw new Error(
        `attendance must cover exactly the ${remaining} remaining round(s)`,
      );
    }
    const n = this.ids.length;
    const attending: number[][] = attendance.map((list, r) => {
      const seen = new Set<number>();
      return list.map((id) => {
        const idx = this.indexOf.get(id);
        if (idx === undefined) {
          throw new Error(`unknown participant id in round ${this.confirmed.length + r}: ${id}`);
        }
        if (seen.has(idx)) {
          throw new Error(`duplicate participant id in round ${this.confirmed.length + r}: ${id}`);
        }
        seen.add(idx);
        return idx;
      });
    });

    // Tentative state starts from confirmed history only.
    const usedPairs = new Set<number>(this.confirmedPairs);
    const byeCount = Int32Array.from(this.confirmedByes);

    // Lexicographic weight encoding:
    //   weight = pairW * W1 + matchedPenaltySum * W2 + tagScore
    // W2 must exceed any tagScore difference; W1 must exceed any
    // difference the lower two objectives can produce.
    const maxTagScore = Math.floor(n / 2) * 64;
    const W2 = maxTagScore + 1;
    const maxPenaltySum = n * (2 * this.rounds + 1);
    const W1 = W2 * maxPenaltySum + maxTagScore + 1;

    const planned: RoundPlan[] = [];
    const objectives: RoundObjectives[] = [];
    for (let r = 0; r < remaining; r++) {
      const here = attending[r]!;
      // Candidate edges: compatible, not used before, both attending.
      const edges: number[] = [];
      for (let a = 0; a < here.length; a++) {
        const i = here[a]!;
        const pi = 2 * byeCount[i]! + 1;
        for (let b = a + 1; b < here.length; b++) {
          const j = here[b]!;
          const key = i < j ? i * n + j : j * n + i;
          if (usedPairs.has(key)) continue;
          const c = this.common[key]!;
          if (c === 0) continue;
          const pj = 2 * byeCount[j]! + 1;
          edges.push(i, j, W1 + (pi + pj) * W2 + c);
        }
      }
      const mate = maxWeightMatching(n, edges);
      const pairs: Array<[string, string]> = [];
      const byes: string[] = [];
      let tagScore = 0;
      for (const i of here) {
        const j = mate[i]!;
        if (j === -1) {
          byes.push(this.ids[i]!);
          byeCount[i]! += 1;
        } else if (i < j) {
          pairs.push([this.ids[i]!, this.ids[j]!]);
          usedPairs.add(i * n + j);
          tagScore += this.common[i * n + j]!;
        }
      }
      let byeSquareSum = 0;
      for (let i = 0; i < n; i++) byeSquareSum += byeCount[i]! * byeCount[i]!;
      planned.push({
        round: this.confirmed.length + r,
        pairs,
        byes,
      });
      objectives.push({
        pairCount: pairs.length,
        byeSquareSum,
        tagScore,
      });
    }
    this.planned = planned;
    this.plannedObjectives = objectives;
    return this.getPlannedRounds();
  }

  /**
   * Confirm the next round. Its content is exactly the corresponding
   * round of the current plan. Rounds must be confirmed in order.
   */
  confirmNextRound(): RoundPlan {
    const next = this.planned.shift();
    if (next === undefined) {
      throw new Error("no planned round to confirm; call generateSchedule first");
    }
    const objectives = this.plannedObjectives.shift()!;
    const n = this.ids.length;
    for (const [a, b] of next.pairs) {
      const i = this.indexOf.get(a)!;
      const j = this.indexOf.get(b)!;
      this.confirmedPairs.add(i < j ? i * n + j : j * n + i);
    }
    for (const id of next.byes) {
      this.confirmedByes[this.indexOf.get(id)!]! += 1;
    }
    this.confirmed.push(next);
    this.confirmedObjectives.push(objectives);
    return next;
  }

  /** Plans of confirmed rounds, in order. */
  getConfirmedRounds(): RoundPlan[] {
    return this.confirmed.map((r) => ({
      round: r.round,
      pairs: r.pairs.map(([a, b]) => [a, b] as [string, string]),
      byes: [...r.byes],
    }));
  }

  /** Current unconfirmed plan (rounds after the confirmed ones). */
  getPlannedRounds(): RoundPlan[] {
    return this.planned.map((r) => ({
      round: r.round,
      pairs: r.pairs.map(([a, b]) => [a, b] as [string, string]),
      byes: [...r.byes],
    }));
  }

  /** Objective values per round: confirmed rounds first, then planned. */
  getRoundObjectives(): RoundObjectives[] {
    return [...this.confirmedObjectives, ...this.plannedObjectives].map((o) => ({
      ...o,
    }));
  }

  /** Cumulative confirmed bye count per participant id. */
  getConfirmedByeCounts(): Map<string, number> {
    const out = new Map<string, number>();
    this.ids.forEach((id, i) => out.set(id, this.confirmedByes[i]!));
    return out;
  }
}
