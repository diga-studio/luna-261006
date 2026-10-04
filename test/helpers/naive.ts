import { BomRevision, BomVersion, CycleWitness, PublishResult } from "../../src/types";

/**
 * Naive reference implementation used only in tests.
 *
 * For a candidate batch it builds the final timeline, then brute-forces every
 * critical day (a version start day) inside every new version's effective
 * window: on each such day it checks, with a plain depth-first search over
 * the graph effective on exactly that day, whether the new edge would close
 * a cycle. Correct by brute force over days, slow by design.
 */
export class NaiveBom {
  private accepted: BomRevision[] = [];

  /**
   * @param seed revisions known acyclic by construction (e.g. the generated
   * large-scale timetable); they are trusted, not brute-force checked.
   */
  constructor(seed: BomRevision[] = []) {
    this.accepted = seed.map(cloneRevision);
  }

  publishBatch(batch: BomRevision[]): PublishResult {
    const all = this.accepted.concat(batch);
    const witness = findAnyCycle(all, batch);
    if (witness) return { ok: false, witness };
    this.accepted = all;
    return { ok: true };
  }

  bomAt(assemblyId: string, day: number): BomVersion | null {
    let best: BomRevision | null = null;
    for (const rev of this.accepted) {
      if (rev.assemblyId !== assemblyId || rev.startDay > day) continue;
      if (!best || rev.startDay > best.startDay) best = rev;
    }
    return best
      ? { assemblyId, startDay: best.startDay, components: best.components.slice() }
      : null;
  }
}

function cloneRevision(rev: BomRevision): BomRevision {
  return { assemblyId: rev.assemblyId, startDay: rev.startDay, components: rev.components.slice() };
}

function findAnyCycle(all: BomRevision[], batch: BomRevision[]): CycleWitness | null {
  const byAssembly = new Map<string, BomRevision[]>();
  for (const rev of all) {
    let list = byAssembly.get(rev.assemblyId);
    if (!list) {
      list = [];
      byAssembly.set(rev.assemblyId, list);
    }
    list.push(rev);
  }
  for (const list of byAssembly.values()) list.sort((a, b) => a.startDay - b.startDay);

  const criticalDays = [...new Set(all.map((r) => r.startDay))].sort((a, b) => a - b);

  for (const rev of batch) {
    const list = byAssembly.get(rev.assemblyId)!;
    let end = Number.POSITIVE_INFINITY;
    for (const other of list) {
      if (other.startDay > rev.startDay) {
        end = other.startDay;
        break;
      }
    }
    for (const component of rev.components) {
      for (const day of criticalDays) {
        if (day < rev.startDay || day >= end) continue;
        const path = reachesOnDay(byAssembly, component, rev.assemblyId, day);
        if (path) {
          return { day, path: [rev.assemblyId, ...path] };
        }
      }
    }
  }
  return null;
}

function activeComponentsAt(
  byAssembly: Map<string, BomRevision[]>,
  assemblyId: string,
  day: number,
): string[] {
  const list = byAssembly.get(assemblyId);
  if (!list) return [];
  let best: BomRevision | null = null;
  for (const rev of list) {
    if (rev.startDay > day) break;
    best = rev;
  }
  return best ? best.components : [];
}

/** Path from `source` to `target` using only edges effective on `day`, or null. */
function reachesOnDay(
  byAssembly: Map<string, BomRevision[]>,
  source: string,
  target: string,
  day: number,
): string[] | null {
  if (source === target) return [source];
  const parent = new Map<string, string>();
  const visited = new Set<string>([source]);
  const stack = [source];
  while (stack.length > 0) {
    const node = stack.pop()!;
    for (const next of activeComponentsAt(byAssembly, node, day)) {
      if (visited.has(next)) continue;
      visited.add(next);
      parent.set(next, node);
      if (next === target) {
        const path = [target];
        let cur = node;
        while (cur !== source) {
          path.unshift(cur);
          cur = parent.get(cur)!;
        }
        path.unshift(source);
        return path;
      }
      stack.push(next);
    }
  }
  return null;
}

/** Checks that the witness path is really closed by edges effective on witness.day. */
export function verifyWitness(
  bomAt: (assemblyId: string, day: number) => BomVersion | null,
  witness: CycleWitness,
): boolean {
  const { day, path } = witness;
  if (path.length < 2 || path[0] !== path[path.length - 1]) return false;
  if (!Number.isInteger(day) || day < 0) return false;
  for (let i = 0; i + 1 < path.length; i++) {
    const version = bomAt(path[i], day);
    if (!version || !version.components.includes(path[i + 1])) return false;
  }
  return true;
}

/** Deterministic PRNG (mulberry32) for reproducible randomized tests. */
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

/** Direct lookup over a raw revision list, ignoring accept/reject bookkeeping. */
export function bomAtFromRevisions(
  revisions: BomRevision[],
): (assemblyId: string, day: number) => BomVersion | null {
  return (assemblyId, day) => {
    let best: BomRevision | null = null;
    for (const rev of revisions) {
      if (rev.assemblyId !== assemblyId || rev.startDay > day) continue;
      if (!best || rev.startDay > best.startDay) best = rev;
    }
    return best
      ? { assemblyId, startDay: best.startDay, components: best.components.slice() }
      : null;
  };
}
