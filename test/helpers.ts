import { baseScore, loadScore } from "../src/scoring.js";
import type { Assignment, Mentor, Newcomer, Objective, PlanInput } from "../src/index.js";

/** 可重复的伪随机数发生器（mulberry32） */
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

export function pickSubset<T>(rng: () => number, items: T[], min: number, max: number): Set<T> {
  const size = pickInt(rng, min, Math.min(max, items.length));
  const chosen = new Set<T>();
  while (chosen.size < size) chosen.add(items[Math.floor(rng() * items.length)]!);
  return chosen;
}

export interface RandomInstanceOptions {
  newcomerCount: [number, number];
  mentorCount: [number, number];
  candidateMin: number;
  candidateMax: number;
  forcedCount: [number, number];
  departments: string[];
  locations: string[];
  tags: string[];
}

/** 生成随机实例；强制指定保证内部一致（不冲突、属于候选集合、不超容量） */
export function randomInstance(rng: () => number, opts: RandomInstanceOptions): PlanInput {
  const mentorCount = pickInt(rng, opts.mentorCount[0], opts.mentorCount[1]);
  const newcomerCount = pickInt(rng, opts.newcomerCount[0], opts.newcomerCount[1]);

  const mentors: Mentor[] = [];
  for (let j = 0; j < mentorCount; j += 1) {
    mentors.push({
      id: `m${j}`,
      department: opts.departments[Math.floor(rng() * opts.departments.length)]!,
      location: opts.locations[Math.floor(rng() * opts.locations.length)]!,
      interests: pickSubset(rng, opts.tags, 0, 4),
      activeMenteeCount: pickInt(rng, 0, 3),
    });
  }

  const newcomers: Newcomer[] = [];
  for (let i = 0; i < newcomerCount; i += 1) {
    newcomers.push({
      id: `n${i}`,
      department: opts.departments[Math.floor(rng() * opts.departments.length)]!,
      location: opts.locations[Math.floor(rng() * opts.locations.length)]!,
      interests: pickSubset(rng, opts.tags, 0, 4),
      candidateMentorIds: pickSubset(
        rng,
        mentors.map((m) => m.id),
        opts.candidateMin,
        opts.candidateMax,
      ),
    });
  }

  // 挑选互不冲突的强制指定
  const forcedAssignments: { newcomerId: string; mentorId: string }[] = [];
  const forcedTarget = pickInt(rng, opts.forcedCount[0], opts.forcedCount[1]);
  const loadByMentor = new Map<string, number>(mentors.map((m) => [m.id, m.activeMenteeCount]));
  const order = [...newcomers].sort(() => rng() - 0.5);
  for (const newcomer of order) {
    if (forcedAssignments.length >= forcedTarget) break;
    const candidates = [...newcomer.candidateMentorIds].filter(
      (id) => loadByMentor.get(id)! < 3,
    );
    if (candidates.length === 0) continue;
    const mentorId = candidates[Math.floor(rng() * candidates.length)]!;
    forcedAssignments.push({ newcomerId: newcomer.id, mentorId });
    loadByMentor.set(mentorId, loadByMentor.get(mentorId)! + 1);
  }

  return { newcomers, mentors, forcedAssignments };
}

/** 字典序比较两个目标：先人数，再总分。返回负数表示 a 更优。 */
export function compareObjective(a: Objective, b: Objective): number {
  if (a.matchedCount !== b.matchedCount) return b.matchedCount - a.matchedCount;
  return b.totalScore - a.totalScore;
}

/**
 * 测试用穷举求解器：枚举所有合法分配，返回字典序最优目标。
 * 仅用于小规模实例的正确性对照。
 */
export function bruteForceOptimal(input: PlanInput): Objective {
  const newcomerById = new Map(input.newcomers.map((n) => [n.id, n]));
  const mentorById = new Map(input.mentors.map((m) => [m.id, m]));

  // 固定强制指定
  const forcedOf = new Map<string, string>();
  const load = new Map<string, number>(input.mentors.map((m) => [m.id, m.activeMenteeCount]));
  for (const forced of input.forcedAssignments) {
    forcedOf.set(forced.newcomerId, forced.mentorId);
    load.set(forced.mentorId, load.get(forced.mentorId)! + 1);
  }

  const free = input.newcomers.filter((n) => !forcedOf.has(n.id));
  const chosen = new Map<string, string>(forcedOf);

  let best: Objective = { matchedCount: -1, totalScore: -Infinity };

  function scoreCurrent(): number {
    const countByMentor = new Map<string, number>();
    for (const mentorId of chosen.values()) {
      countByMentor.set(mentorId, (countByMentor.get(mentorId) ?? 0) + 1);
    }
    let total = 0;
    for (const [newcomerId, mentorId] of chosen) {
      const newcomer = newcomerById.get(newcomerId)!;
      const mentor = mentorById.get(mentorId)!;
      const finalLoad = mentor.activeMenteeCount + countByMentor.get(mentorId)!;
      total += baseScore(newcomer, mentor) + loadScore(finalLoad);
    }
    return total;
  }

  function consider(): void {
    const candidate: Objective = { matchedCount: chosen.size, totalScore: scoreCurrent() };
    if (compareObjective(candidate, best) < 0) best = candidate;
  }

  function dfs(index: number): void {
    if (index === free.length) {
      consider();
      return;
    }
    const newcomer = free[index]!;
    // 选项一：不分配
    dfs(index + 1);
    // 选项二：分配给仍有容量的候选导师
    for (const mentorId of newcomer.candidateMentorIds) {
      if (load.get(mentorId)! >= 3) continue;
      load.set(mentorId, load.get(mentorId)! + 1);
      chosen.set(newcomer.id, mentorId);
      dfs(index + 1);
      chosen.delete(newcomer.id);
      load.set(mentorId, load.get(mentorId)! - 1);
    }
  }

  dfs(0);
  return best;
}

/** 由配对结果重新计算目标值（与 evaluatePlan 同一口径的独立实现） */
export function objectiveOf(input: PlanInput, assignments: Assignment[]): Objective {
  const newcomerById = new Map(input.newcomers.map((n) => [n.id, n]));
  const mentorById = new Map(input.mentors.map((m) => [m.id, m]));
  const countByMentor = new Map<string, number>();
  for (const a of assignments) {
    countByMentor.set(a.mentorId, (countByMentor.get(a.mentorId) ?? 0) + 1);
  }
  let totalScore = 0;
  for (const a of assignments) {
    const newcomer = newcomerById.get(a.newcomerId)!;
    const mentor = mentorById.get(a.mentorId)!;
    const finalLoad = mentor.activeMenteeCount + countByMentor.get(a.mentorId)!;
    totalScore += baseScore(newcomer, mentor) + loadScore(finalLoad);
  }
  return { matchedCount: assignments.length, totalScore };
}
