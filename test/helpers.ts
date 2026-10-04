import { loadTerm, pairStaticScore } from "../src/score.js";
import type { Assignment, BatchInput, Mentor, Newcomer } from "../src/types.js";

/** Deterministic PRNG (mulberry32). */
export function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pickInt(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

export interface RandomInstanceOptions {
  newcomerCount: number;
  mentorCount: number;
  /** Candidate list length per newcomer, inclusive range. */
  candidateRange: [number, number];
  departments: number;
  locations: number;
  interestTags: number;
  maxInterests: number;
  /** Probability a newcomer gets a forced pair (from its candidates). */
  forcedRate: number;
  /** Historical load distribution weights for 0..3. */
  historicalWeights?: [number, number, number, number];
}

export function generateInstance(seed: number, opts: RandomInstanceOptions): BatchInput {
  const rng = makeRng(seed);
  const weights = opts.historicalWeights ?? [4, 3, 2, 1];
  const weightSum = weights[0] + weights[1] + weights[2] + weights[3];

  const mentors: Mentor[] = [];
  for (let i = 0; i < opts.mentorCount; i += 1) {
    const roll = rng() * weightSum;
    let historical = 0;
    let acc = 0;
    for (let h = 0; h < 4; h += 1) {
      acc += weights[h];
      if (roll < acc) {
        historical = h;
        break;
      }
    }
    const interests = new Set<string>();
    const interestCount = pickInt(rng, 0, opts.maxInterests);
    while (interests.size < interestCount) {
      interests.add(`tag${pickInt(rng, 0, opts.interestTags - 1)}`);
    }
    mentors.push({
      id: `m${i}`,
      department: `dept${pickInt(rng, 0, opts.departments - 1)}`,
      location: `loc${pickInt(rng, 0, opts.locations - 1)}`,
      interests,
      historicalActive: historical,
    });
  }

  const newcomers: Newcomer[] = [];
  const forced: Array<{ newcomerId: string; mentorId: string }> = [];
  const forcedLoad = new Map<string, number>();
  for (let i = 0; i < opts.newcomerCount; i += 1) {
    const interests = new Set<string>();
    const interestCount = pickInt(rng, 0, opts.maxInterests);
    while (interests.size < interestCount) {
      interests.add(`tag${pickInt(rng, 0, opts.interestTags - 1)}`);
    }
    const candidateCount = pickInt(rng, opts.candidateRange[0], opts.candidateRange[1]);
    const candidates = new Set<string>();
    while (candidates.size < Math.min(candidateCount, mentors.length)) {
      candidates.add(mentors[pickInt(rng, 0, mentors.length - 1)].id);
    }
    const newcomer: Newcomer = {
      id: `n${i}`,
      department: `dept${pickInt(rng, 0, opts.departments - 1)}`,
      location: `loc${pickInt(rng, 0, opts.locations - 1)}`,
      interests,
      candidateMentorIds: [...candidates],
    };
    newcomers.push(newcomer);

    if (rng() < opts.forcedRate && newcomer.candidateMentorIds.length > 0) {
      const mentorId = newcomer.candidateMentorIds[pickInt(rng, 0, newcomer.candidateMentorIds.length - 1)];
      const mentor = mentors.find((m) => m.id === mentorId) as Mentor;
      const used = forcedLoad.get(mentorId) ?? 0;
      if (mentor.historicalActive + used + 1 <= 3) {
        forced.push({ newcomerId: newcomer.id, mentorId });
        forcedLoad.set(mentorId, used + 1);
      }
    }
  }
  return { newcomers, mentors, forced };
}

export interface OptimalObjective {
  matchedCount: number;
  totalScore: number;
}

/**
 * Exact brute-force optimum over all legal assignments: lexicographically
 * maximize (matchedCount, totalScore). Only feasible for tiny instances.
 */
export function bruteForceOptimal(input: BatchInput): OptimalObjective {
  const mentors = new Map(input.mentors.map((m) => [m.id, m]));
  const forcedByNewcomer = new Map(input.forced.map((f) => [f.newcomerId, f.mentorId]));
  const load = new Map(input.mentors.map((m) => [m.id, m.historicalActive]));

  let best: OptimalObjective = { matchedCount: -1, totalScore: -Infinity };

  const consider = (assignments: Assignment[]): void => {
    const countByMentor = new Map<string, number>();
    for (const a of assignments) {
      countByMentor.set(a.mentorId, (countByMentor.get(a.mentorId) ?? 0) + 1);
    }
    let total = 0;
    for (const a of assignments) {
      const newcomer = input.newcomers.find((n) => n.id === a.newcomerId) as Newcomer;
      const mentor = mentors.get(a.mentorId) as Mentor;
      const finalLoad = mentor.historicalActive + (countByMentor.get(a.mentorId) ?? 0);
      total += pairStaticScore(newcomer, mentor) + loadTerm(finalLoad);
    }
    const candidate: OptimalObjective = { matchedCount: assignments.length, totalScore: total };
    if (
      candidate.matchedCount > best.matchedCount ||
      (candidate.matchedCount === best.matchedCount && candidate.totalScore > best.totalScore)
    ) {
      best = candidate;
    }
  };

  const current: Assignment[] = [];
  const recurse = (index: number): void => {
    if (index === input.newcomers.length) {
      consider(current);
      return;
    }
    const newcomer = input.newcomers[index];
    const forcedMentor = forcedByNewcomer.get(newcomer.id);
    if (forcedMentor !== undefined) {
      // Forced pairs must be kept; only feasible if capacity allows.
      if ((load.get(forcedMentor) ?? 0) < 3) {
        load.set(forcedMentor, (load.get(forcedMentor) ?? 0) + 1);
        current.push({ newcomerId: newcomer.id, mentorId: forcedMentor });
        recurse(index + 1);
        current.pop();
        load.set(forcedMentor, (load.get(forcedMentor) ?? 0) - 1);
      }
      return;
    }
    // Option 1: leave unassigned.
    recurse(index + 1);
    // Option 2: assign to a candidate with spare capacity.
    for (const cand of newcomer.candidateMentorIds) {
      if ((load.get(cand) ?? 0) >= 3) continue;
      load.set(cand, (load.get(cand) ?? 0) + 1);
      current.push({ newcomerId: newcomer.id, mentorId: cand });
      recurse(index + 1);
      current.pop();
      load.set(cand, (load.get(cand) ?? 0) - 1);
    }
  };
  recurse(0);
  return best;
}
