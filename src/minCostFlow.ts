/**
 * Min-cost flow via successive shortest augmenting paths (SPFA).
 *
 * Edge costs are bigint so that arbitrarily large lexicographic weights
 * stay exact regardless of instance size. The solver augments only while
 * the cheapest s-t path has negative cost, which yields the minimum-cost
 * flow over all possible flow values (no negative residual cycles are
 * ever created by shortest-path augmentation).
 */

interface Arc {
  to: number;
  rev: number;
  cap: number;
  cost: bigint;
}

export interface FlowResult {
  flow: number;
  cost: bigint;
}

export class MinCostFlow {
  private readonly graph: Arc[][];
  private readonly forwardArcs: { from: number; index: number; cap: number }[] = [];

  constructor(nodeCount: number) {
    this.graph = Array.from({ length: nodeCount }, () => []);
  }

  /** Adds a directed edge; returns a handle usable with flowOn(). */
  addEdge(from: number, to: number, cap: number, cost: bigint): number {
    const forward: Arc = { to, rev: this.graph[to]!.length, cap, cost };
    const backward: Arc = { to: from, rev: this.graph[from]!.length, cap: 0, cost: -cost };
    this.graph[from]!.push(forward);
    this.graph[to]!.push(backward);
    this.forwardArcs.push({ from, index: this.graph[from]!.length - 1, cap });
    return this.forwardArcs.length - 1;
  }

  /** Flow currently pushed through the edge created by addEdge (0..cap). */
  flowOn(handle: number): number {
    const ref = this.forwardArcs[handle]!;
    return ref.cap - this.graph[ref.from]![ref.index]!.cap;
  }

  /** Augments while it strictly reduces total cost; returns final flow and cost. */
  minimizeCost(source: number, sink: number): FlowResult {
    let flow = 0;
    let cost = 0n;
    for (;;) {
      const path = this.shortestPath(source, sink);
      if (path === null || path.cost >= 0n) break;
      let add = Number.POSITIVE_INFINITY;
      for (const arc of path.arcs) add = Math.min(add, arc.cap);
      for (const arc of path.arcs) {
        arc.cap -= add;
        this.graph[arc.to]![arc.rev]!.cap += add;
      }
      flow += add;
      cost += path.cost * BigInt(add);
    }
    return { flow, cost };
  }

  private shortestPath(source: number, sink: number): { cost: bigint; arcs: Arc[] } | null {
    const n = this.graph.length;
    const dist: (bigint | null)[] = new Array(n).fill(null);
    const inQueue = new Array<boolean>(n).fill(false);
    const prevNode = new Array<number>(n).fill(-1);
    const prevArc: (Arc | null)[] = new Array<Arc | null>(n).fill(null);
    dist[source] = 0n;
    const queue: number[] = [source];
    inQueue[source] = true;
    while (queue.length > 0) {
      const u = queue.shift()!;
      inQueue[u] = false;
      const du = dist[u]!;
      for (const arc of this.graph[u]!) {
        if (arc.cap <= 0) continue;
        const candidate = du + arc.cost;
        if (dist[arc.to] === null || candidate < dist[arc.to]!) {
          dist[arc.to] = candidate;
          prevNode[arc.to] = u;
          prevArc[arc.to] = arc;
          if (!inQueue[arc.to]) {
            queue.push(arc.to);
            inQueue[arc.to] = true;
          }
        }
      }
    }
    const sinkCost = dist[sink];
    if (sinkCost === null || sinkCost === undefined) return null;
    const arcs: Arc[] = [];
    for (let v = sink; v !== source; v = prevNode[v]!) arcs.push(prevArc[v]!);
    arcs.reverse();
    return { cost: sinkCost, arcs };
  }
}
