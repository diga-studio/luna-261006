import type { BomRevision } from "../src/types";

/** 朴素参考：直接按定义求 assemblyId 在 day 当天生效的版本。 */
export function naiveBomAt(
  versions: readonly BomRevision[],
  assemblyId: string,
  day: number,
): BomRevision | null {
  let best: BomRevision | null = null;
  for (const revision of versions) {
    if (revision.assemblyId !== assemblyId) continue;
    if (revision.startDay <= day && (best === null || revision.startDay > best.startDay)) {
      best = revision;
    }
  }
  return best;
}

/** 朴素参考：在 day 当天把所有生效边连起来，用 DFS 找一个有向环。 */
export function naiveCycleAt(
  versions: readonly BomRevision[],
  day: number,
): string[] | null {
  const assemblies = new Set<string>();
  for (const revision of versions) {
    assemblies.add(revision.assemblyId);
    for (const component of revision.components) assemblies.add(component);
  }
  const adj = new Map<string, string[]>();
  for (const assembly of assemblies) {
    const effective = naiveBomAt(versions, assembly, day);
    if (effective !== null && effective.components.length > 0) {
      adj.set(assembly, [...effective.components]);
    }
  }
  // 迭代 DFS，白/灰/黑三色标记，灰色栈上发现回边即提取环。
  const color = new Map<string, number>(); // 0=白 1=灰 2=黑
  const stack: string[] = [];
  const callStack: Array<[string, number]> = [];
  for (const seed of assemblies) {
    if (color.get(seed) !== undefined) continue;
    callStack.push([seed, 0]);
    color.set(seed, 1);
    stack.push(seed);
    while (callStack.length > 0) {
      const frame = callStack[callStack.length - 1]!;
      const node = frame[0];
      const neighbors = adj.get(node) ?? [];
      if (frame[1] < neighbors.length) {
        const next = neighbors[frame[1]!]!;
        frame[1]++;
        const c = color.get(next) ?? 0;
        if (c === 0) {
          color.set(next, 1);
          stack.push(next);
          callStack.push([next, 0]);
        } else if (c === 1) {
          const at = stack.indexOf(next);
          return [...stack.slice(at), next];
        }
      } else {
        color.set(node, 2);
        stack.pop();
        callStack.pop();
      }
    }
  }
  return null;
}

/** 朴素参考：逐边界日检查，返回第一个成环的见证。 */
export function naiveDetect(
  versions: readonly BomRevision[],
): { day: number; path: string[] } | null {
  const days = new Set<number>();
  for (const revision of versions) days.add(revision.startDay);
  const sorted = [...days].sort((a, b) => a - b);
  for (const day of sorted) {
    const path = naiveCycleAt(versions, day);
    if (path !== null) return { day, path };
  }
  return null;
}

/** 校验见证：path 在 day 当天确实是闭合物料路径。 */
export function verifyWitness(
  versions: readonly BomRevision[],
  day: number,
  path: readonly string[],
): boolean {
  if (path.length < 2) return false;
  if (path[0] !== path[path.length - 1]) return false;
  if (!Number.isInteger(day) || day < 0) return false;
  for (let i = 0; i + 1 < path.length; i++) {
    const effective = naiveBomAt(versions, path[i]!, day);
    if (effective === null || !effective.components.includes(path[i + 1]!)) return false;
  }
  return true;
}

/** 可复现的伪随机数发生器。 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomInt(rand: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rand() * (hi - lo + 1));
}
