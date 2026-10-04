/**
 * Maximum-weight branching (Edmonds' algorithm): picks a set of edges with
 * indegree at most one per node and no directed cycles, maximizing the total
 * weight. Weights are BigInts so several objectives can be packed
 * lexicographically into a single number.
 *
 * Implemented as a maximum spanning arborescence rooted at a dummy root:
 * the dummy root has a zero-weight edge to every node, so every (super)node
 * always receives exactly one incoming edge and every contracted cycle is
 * guaranteed to be entered exactly once during expansion. Children of the
 * dummy root in the final arborescence are the roots of the branching.
 */
export interface WeightedEdge {
  from: number;
  to: number;
  weight: bigint;
}

/** An arc at one recursion level; `ref` is the edge object of the level above. */
interface Arc<E> {
  u: number;
  v: number;
  w: bigint;
  ref: E;
}

/**
 * Solves one recursion level of the rooted arborescence problem: every node
 * except `root` must end up with exactly one incoming arc. Returns the chosen
 * arcs (a subset of `arcs`).
 */
function solveLevel<E>(
  nodes: readonly number[],
  arcs: readonly Arc<E>[],
  root: number,
): Arc<E>[] {
  // Best incoming arc per node. Every non-root node has at least the dummy
  // arc from the root, so `best` is complete for every non-root node.
  const best = new Map<number, Arc<E>>();
  for (const arc of arcs) {
    if (arc.u === arc.v || arc.v === root) continue;
    const cur = best.get(arc.v);
    if (cur === undefined || arc.w > cur.w) best.set(arc.v, arc);
  }

  // Find directed cycles among the chosen arcs. The root has no incoming
  // arc, so every walk ends at the root or closes a cycle.
  const compOf = new Map<number, number>();
  const cycles: number[][] = [];
  const visited = new Set<number>();
  for (const start of nodes) {
    if (visited.has(start)) continue;
    const pos = new Map<number, number>();
    const path: number[] = [];
    let cur: number | undefined = start;
    while (cur !== undefined && cur !== root && !visited.has(cur) && !pos.has(cur)) {
      pos.set(cur, path.length);
      path.push(cur);
      cur = best.get(cur)?.u;
    }
    if (cur !== undefined && cur !== root && pos.has(cur)) {
      const cycle = path.slice(pos.get(cur)!);
      const id = cycles.length;
      for (const n of cycle) compOf.set(n, id);
      cycles.push(cycle);
    }
    for (const n of path) visited.add(n);
  }

  if (cycles.length === 0) {
    return [...best.values()];
  }

  // Contract every cycle into a supernode; singletons get their own ids.
  let nextComp = cycles.length;
  for (const n of nodes) {
    if (!compOf.has(n)) compOf.set(n, nextComp++);
  }
  const compIds = Array.from({ length: nextComp }, (_, i) => i);
  const rootComp = compOf.get(root)!;

  const contracted: Arc<Arc<E>>[] = [];
  for (const arc of arcs) {
    const cu = compOf.get(arc.u)!;
    const cv = compOf.get(arc.v)!;
    if (cu === cv) continue;
    // Entering a cycle: pay for dropping the cycle arc into the entry node.
    const w = cv < cycles.length ? arc.w - best.get(arc.v)!.w : arc.w;
    contracted.push({ u: cu, v: cv, w, ref: arc });
  }

  const chosenContracted = solveLevel(compIds, contracted, rootComp);

  // Expand: every contracted cycle is entered by exactly one chosen arc.
  const chosen: Arc<E>[] = [];
  const entered = new Set<number>();
  for (const ca of chosenContracted) {
    chosen.push(ca.ref);
    const cv = compOf.get(ca.ref.v)!;
    if (cv < cycles.length) entered.add(ca.ref.v);
  }
  for (const cycle of cycles) {
    const entry = cycle.find((n) => entered.has(n));
    if (entry === undefined) {
      throw new Error("internal error: contracted cycle was not entered");
    }
    for (const n of cycle) {
      if (n !== entry) chosen.push(best.get(n)!);
    }
  }
  return chosen;
}

/**
 * Returns the chosen edges as a map child -> parent. Self-loops are never
 * chosen. Nodes absent from the map are the roots of the branching.
 */
export function maxBranching(
  nodeIds: readonly number[],
  edges: readonly WeightedEdge[],
): Map<number, number> {
  if (nodeIds.length === 0) return new Map();
  let root = 0;
  for (const id of nodeIds) root = Math.min(root, id);
  root -= 1;

  const arcs: Arc<WeightedEdge | null>[] = edges.map((e) => ({
    u: e.from,
    v: e.to,
    w: e.weight,
    ref: e,
  }));
  for (const id of nodeIds) {
    arcs.push({ u: root, v: id, w: 0n, ref: null });
  }

  const chosen = solveLevel([root, ...nodeIds], arcs, root);
  const parents = new Map<number, number>();
  for (const arc of chosen) {
    if (arc.ref !== null) parents.set(arc.ref.to, arc.ref.from);
  }
  return parents;
}
