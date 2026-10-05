import type { Judge, PlanInput, Project, ReviewTask } from "../../src/types.js";

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randInt(rand: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rand() * (hi - lo + 1));
}

export function shuffle<T>(rand: () => number, arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export function sample<T>(
  rand: () => number,
  arr: T[],
  count: number,
): T[] {
  return shuffle(rand, arr).slice(0, Math.min(count, arr.length));
}

/** Small random instance suitable for brute-force cross-checking. */
export function randomSmallInput(seed: number): PlanInput {
  const rand = rng(seed);
  const judgeCount = randInt(rand, 3, 6);
  const judges: Judge[] = Array.from({ length: judgeCount }, (_, i) => ({
    id: `j${i}`,
    baseLoad: randInt(rand, 0, 3),
    capacity: randInt(rand, 0, 4),
  }));

  const taskCount = randInt(rand, 1, 4);
  const projects: Project[] = [];
  const tasks: ReviewTask[] = [];
  const usedCapacity = new Array<number>(judgeCount).fill(0);

  for (let t = 0; t < taskCount; t++) {
    const kind = rand() < 0.4 ? "appeal" : "normal";
    const creator = `j${randInt(rand, 0, judgeCount - 1)}`;
    const stakeholders = sample(
      rand,
      judges.map((j) => j.id),
      randInt(rand, 0, 2),
    ).filter((id) => id !== creator);
    const roundCount = randInt(rand, 0, 2);
    const rounds = Array.from({ length: roundCount }, () =>
      sample(
        rand,
        judges.map((j) => j.id),
        randInt(rand, 0, 2),
      ),
    );
    projects.push({
      id: `p${t}`,
      creatorId: creator,
      stakeholderIds: stakeholders,
      rounds,
    });

    const requiredJudges = randInt(rand, 1, 3);
    // Lock 0-1 judges that are eligible and have spare capacity.
    const blocked = new Set([creator, ...stakeholders]);
    if (kind === "appeal") {
      for (const round of rounds) for (const id of round) blocked.add(id);
    }
    const lockable = judges
      .map((j, idx) => ({ id: j.id, idx }))
      .filter(
        ({ id, idx }) =>
          !blocked.has(id) &&
          usedCapacity[idx]! < judges[idx]!.capacity,
      )
      .map(({ id }) => id);
    const locked = sample(rand, lockable, randInt(rand, 0, Math.min(1, requiredJudges, lockable.length)));
    for (const id of locked) {
      usedCapacity[Number(id.slice(1))]! += 1;
    }
    const preferred = sample(
      rand,
      judges.map((j) => j.id),
      randInt(rand, 0, 3),
    );

    tasks.push({
      id: `t${t}`,
      projectId: `p${t}`,
      kind,
      requiredJudges,
      lockedJudgeIds: locked,
      preferredJudgeIds: preferred,
    });
  }

  return { judges, tasks, projects };
}
