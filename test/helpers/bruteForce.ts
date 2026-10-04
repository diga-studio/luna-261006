import type { CanvasGraph } from "../../src/types";

export interface BruteOptimum {
  rootCount: number;
  totalCost: number;
  /** Parent id per node (node ids ascending, 0 = top-level). */
  sequence: number[];
}

/**
 * Independent exhaustive-search optimum for small graphs, used to
 * cross-check the library against a verifiable global optimum.
 */
export function bruteForceOptimum(graph: CanvasGraph): BruteOptimum {
  const ids = graph.nodes.map((node) => node.id).sort((a, b) => a - b);
  const coordOf = new Map(graph.nodes.map((node) => [node.id, node]));

  const incoming = new Map<number, number[]>();
  for (const id of ids) {
    incoming.set(id, [0]);
  }
  for (const edge of graph.edges) {
    if (edge.from !== edge.to) {
      incoming.get(edge.to)!.push(edge.from);
    }
  }
  for (const id of ids) {
    incoming.set(id, [...new Set(incoming.get(id)!)].sort((a, b) => a - b));
  }

  const costOf = (fromId: number, toId: number): number => {
    const a = coordOf.get(fromId)!;
    const b = coordOf.get(toId)!;
    return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  };

  const assignment: number[] = new Array<number>(ids.length).fill(0);
  let best: BruteOptimum | null = null;

  const isAcyclic = (): boolean => {
    const parentOf = new Map<number, number>();
    ids.forEach((id, i) => parentOf.set(id, assignment[i]!));
    for (const id of ids) {
      let current = id;
      for (let steps = 0; steps <= ids.length; steps++) {
        const parent = parentOf.get(current)!;
        if (parent === 0) {
          break;
        }
        if (steps === ids.length) {
          return false;
        }
        current = parent;
      }
    }
    return true;
  };

  const consider = (): void => {
    if (!isAcyclic()) {
      return;
    }
    let rootCount = 0;
    let totalCost = 0;
    for (let i = 0; i < ids.length; i++) {
      const parent = assignment[i]!;
      if (parent === 0) {
        rootCount++;
      } else {
        totalCost += costOf(parent, ids[i]!);
      }
    }
    const candidate: BruteOptimum = {
      rootCount,
      totalCost,
      sequence: [...assignment],
    };
    if (
      best === null ||
      candidate.rootCount < best.rootCount ||
      (candidate.rootCount === best.rootCount &&
        (candidate.totalCost < best.totalCost ||
          (candidate.totalCost === best.totalCost &&
            candidate.sequence.some((v, i) => v !== best!.sequence[i]) &&
            lessThan(candidate.sequence, best.sequence))))
    ) {
      best = candidate;
    }
  };

  const lessThan = (a: number[], b: number[]): boolean => {
    for (let i = 0; i < a.length; i++) {
      if (a[i]! !== b[i]!) {
        return a[i]! < b[i]!;
      }
    }
    return false;
  };

  const recurse = (index: number): void => {
    if (index === ids.length) {
      consider();
      return;
    }
    for (const parent of incoming.get(ids[index]!)!) {
      assignment[index] = parent;
      recurse(index + 1);
    }
  };
  recurse(0);

  if (best === null) {
    throw new Error("brute force found no assignment");
  }
  return best;
}
