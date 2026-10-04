import { MinCostFlow } from "./mincostflow.js";
import { loadTerm, marginalLoadScore, pairStaticScore } from "./score.js";
import type {
  Assignment,
  BatchInput,
  EvaluationResult,
  Mentor,
  Newcomer,
  PlanResult,
} from "./types.js";

// Scores are doubled so every cost is an integer (the 7.5 load term becomes 15).
// Each unit of flow crosses exactly one newcomer->mentor edge and one
// mentor->sink slot edge, so adding these constant shifts per unit of flow
// changes the total cost by exactly (PAIR_SHIFT + SLOT_SHIFT) * flow. With the
// flow value fixed at the maximum, minimizing shifted cost is exactly
// maximizing the true total score.
const PAIR_SHIFT = 2 * (30 + 10 + 25 + 20); // 170, >= 2 * max static pair score
const SLOT_SHIFT = 2 * 15; // 30, >= 2 * max marginal load score

interface IndexedInput {
  newcomers: ReadonlyMap<string, Newcomer>;
  mentors: ReadonlyMap<string, Mentor>;
  forcedByNewcomer: ReadonlyMap<string, string>;
}

function indexInput(input: BatchInput): IndexedInput {
  const newcomers = new Map<string, Newcomer>();
  for (const n of input.newcomers) {
    if (newcomers.has(n.id)) throw new Error(`duplicate newcomer id: ${n.id}`);
    newcomers.set(n.id, n);
  }
  const mentors = new Map<string, Mentor>();
  for (const m of input.mentors) {
    if (mentors.has(m.id)) throw new Error(`duplicate mentor id: ${m.id}`);
    if (!Number.isInteger(m.historicalActive) || m.historicalActive < 0 || m.historicalActive > 3) {
      throw new Error(`mentor ${m.id} historicalActive out of range: ${m.historicalActive}`);
    }
    mentors.set(m.id, m);
  }
  for (const n of input.newcomers) {
    for (const cand of n.candidateMentorIds) {
      if (!mentors.has(cand)) {
        throw new Error(`newcomer ${n.id} lists unknown candidate mentor: ${cand}`);
      }
    }
  }
  const forcedByNewcomer = new Map<string, string>();
  for (const f of input.forced) {
    forcedByNewcomer.set(f.newcomerId, f.mentorId);
  }
  return { newcomers, mentors, forcedByNewcomer };
}

/** Validates forced pairs; returns a conflict reason or null. */
function checkForced(input: BatchInput, idx: IndexedInput): string | null {
  const seen = new Set<string>();
  const forcedCountByMentor = new Map<string, number>();
  for (const f of input.forced) {
    const newcomer = idx.newcomers.get(f.newcomerId);
    if (!newcomer) return `forced pair references unknown newcomer: ${f.newcomerId}`;
    if (!idx.mentors.has(f.mentorId)) return `forced pair references unknown mentor: ${f.mentorId}`;
    if (seen.has(f.newcomerId)) return `newcomer ${f.newcomerId} has conflicting forced pairs`;
    seen.add(f.newcomerId);
    if (!newcomer.candidateMentorIds.includes(f.mentorId)) {
      return `forced mentor ${f.mentorId} is not a candidate of newcomer ${f.newcomerId}`;
    }
    const count = (forcedCountByMentor.get(f.mentorId) ?? 0) + 1;
    forcedCountByMentor.set(f.mentorId, count);
    const mentor = idx.mentors.get(f.mentorId) as Mentor;
    if (mentor.historicalActive + count > 3) {
      return `forced pairs exceed capacity of mentor ${f.mentorId}`;
    }
  }
  return null;
}

/** Recomputes per-newcomer scores from scratch using final mentor loads. */
function computeScores(
  idx: IndexedInput,
  assignments: readonly Assignment[],
): { matchedCount: number; scores: Record<string, number>; totalScore: number } {
  const finalLoad = new Map<string, number>();
  for (const m of idx.mentors.values()) finalLoad.set(m.id, m.historicalActive);
  for (const a of assignments) {
    finalLoad.set(a.mentorId, (finalLoad.get(a.mentorId) ?? 0) + 1);
  }
  const scores: Record<string, number> = {};
  let totalScore = 0;
  for (const a of assignments) {
    const newcomer = idx.newcomers.get(a.newcomerId);
    const mentor = idx.mentors.get(a.mentorId);
    if (!newcomer || !mentor) continue;
    const load = finalLoad.get(a.mentorId) as number;
    // Out-of-range loads only occur in invalid plans; the violation is
    // reported separately, so score them with a zero load term.
    const score = pairStaticScore(newcomer, mentor) + (load >= 1 && load <= 3 ? loadTerm(load) : 0);
    scores[a.newcomerId] = score;
    totalScore += score;
  }
  return { matchedCount: Object.keys(scores).length, scores, totalScore };
}

export function planBatch(input: BatchInput): PlanResult {
  const idx = indexInput(input);
  const conflict = checkForced(input, idx);
  if (conflict !== null) {
    return {
      feasible: false,
      reason: conflict,
      assignments: [],
      unassignedNewcomerIds: input.newcomers.map((n) => n.id),
      matchedCount: 0,
      scores: {},
      totalScore: 0,
    };
  }

  const newcomerList = [...idx.newcomers.values()];
  const mentorList = [...idx.mentors.values()];
  const newcomerNode = new Map<string, number>();
  const mentorNode = new Map<string, number>();
  newcomerList.forEach((n, i) => newcomerNode.set(n.id, 1 + i));
  mentorList.forEach((m, i) => mentorNode.set(m.id, 1 + newcomerList.length + i));
  const source = 0;
  const sink = 1 + newcomerList.length + mentorList.length;

  const flow = new MinCostFlow(sink + 1);
  const pairEdges: Array<{ newcomerId: string; mentorId: string; edge: number }> = [];

  const forcedCountByMentor = new Map<string, number>();
  for (const f of input.forced) {
    forcedCountByMentor.set(f.mentorId, (forcedCountByMentor.get(f.mentorId) ?? 0) + 1);
  }

  for (const n of newcomerList) {
    if (idx.forcedByNewcomer.has(n.id)) continue; // forced pairs are pre-assigned
    flow.addEdge(source, newcomerNode.get(n.id) as number, 1, 0);
    const seen = new Set<string>();
    for (const cand of n.candidateMentorIds) {
      if (seen.has(cand)) continue;
      seen.add(cand);
      const mentor = idx.mentors.get(cand) as Mentor;
      const cost = PAIR_SHIFT - 2 * pairStaticScore(n, mentor);
      const edge = flow.addEdge(newcomerNode.get(n.id) as number, mentorNode.get(cand) as number, 1, cost);
      pairEdges.push({ newcomerId: n.id, mentorId: cand, edge });
    }
  }

  for (const m of mentorList) {
    const forcedCount = forcedCountByMentor.get(m.id) ?? 0;
    for (let slot = 1; m.historicalActive + forcedCount + slot <= 3; slot += 1) {
      const cost = SLOT_SHIFT - 2 * marginalLoadScore(forcedCount + slot, m.historicalActive);
      flow.addEdge(mentorNode.get(m.id) as number, sink, 1, cost);
    }
  }

  flow.minCostMaxFlow(source, sink);

  const assignments: Assignment[] = input.forced.map((f) => ({
    newcomerId: f.newcomerId,
    mentorId: f.mentorId,
  }));
  for (const p of pairEdges) {
    if (flow.flowOn(p.edge) === 1) {
      assignments.push({ newcomerId: p.newcomerId, mentorId: p.mentorId });
    }
  }

  const { matchedCount, scores, totalScore } = computeScores(idx, assignments);
  const matched = new Set(assignments.map((a) => a.newcomerId));
  return {
    feasible: true,
    assignments,
    unassignedNewcomerIds: newcomerList.filter((n) => !matched.has(n.id)).map((n) => n.id),
    matchedCount,
    scores,
    totalScore,
  };
}

export function evaluatePlan(input: BatchInput, assignments: readonly Assignment[]): EvaluationResult {
  const idx = indexInput(input);
  const violations: string[] = [];

  const assignedMentorByNewcomer = new Map<string, string>();
  const batchCountByMentor = new Map<string, number>();
  for (const a of assignments) {
    const newcomer = idx.newcomers.get(a.newcomerId);
    const mentor = idx.mentors.get(a.mentorId);
    if (!newcomer) {
      violations.push(`assignment references unknown newcomer: ${a.newcomerId}`);
      continue;
    }
    if (!mentor) {
      violations.push(`assignment references unknown mentor: ${a.mentorId}`);
      continue;
    }
    if (assignedMentorByNewcomer.has(a.newcomerId)) {
      violations.push(`newcomer ${a.newcomerId} is assigned more than once`);
      continue;
    }
    if (!newcomer.candidateMentorIds.includes(a.mentorId)) {
      violations.push(`mentor ${a.mentorId} is not a candidate of newcomer ${a.newcomerId}`);
    }
    assignedMentorByNewcomer.set(a.newcomerId, a.mentorId);
    const count = (batchCountByMentor.get(a.mentorId) ?? 0) + 1;
    batchCountByMentor.set(a.mentorId, count);
    if (mentor.historicalActive + count > 3) {
      violations.push(`mentor ${a.mentorId} final load exceeds 3`);
    }
  }
  for (const f of input.forced) {
    if (assignedMentorByNewcomer.get(f.newcomerId) !== f.mentorId) {
      violations.push(`forced pair ${f.newcomerId} -> ${f.mentorId} is not preserved`);
    }
  }

  const { matchedCount, scores, totalScore } = computeScores(idx, assignments);
  return { valid: violations.length === 0, violations, matchedCount, scores, totalScore };
}
