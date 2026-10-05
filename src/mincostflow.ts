/**
 * Min-cost flow over a directed graph with non-negative integer costs,
 * solved by successive shortest augmenting paths with Johnson potentials.
 *
 * Costs may exceed 2^32 but must stay well below 2^53 (exact in float64).
 */

export interface FlowEdge {
  to: number;
  rev: number;
  cap: number;
  cost: number;
}

export class MinCostFlow {
  private readonly graph: FlowEdge[][] = [];

  addNode(): number {
    this.graph.push([]);
    return this.graph.length - 1;
  }

  nodeCount(): number {
    return this.graph.length;
  }

  /** Adds a directed edge plus its residual reverse edge. */
  addEdge(from: number, to: number, capacity: number, cost: number): FlowEdge {
    const forward: FlowEdge = {
      to,
      rev: this.graph[to]!.length,
      cap: capacity,
      cost,
    };
    const backward: FlowEdge = {
      to: from,
      rev: this.graph[from]!.length,
      cap: 0,
      cost: -cost,
    };
    this.graph[from]!.push(forward);
    this.graph[to]!.push(backward);
    return forward;
  }

  /**
   * Pushes flow from source to sink until `limit` units are sent or no
   * augmenting path remains. Returns [flow, cost].
   */
  solve(source: number, sink: number, limit: number): [number, number] {
    const n = this.graph.length;
    const potential = new Array<number>(n).fill(0);
    const dist = new Array<number>(n);
    const prevNode = new Array<number>(n);
    const prevEdge = new Array<number>(n);
    let flow = 0;
    let cost = 0;

    while (flow < limit) {
      dist.fill(Infinity);
      dist[source] = 0;
      const heap = new MinHeap();
      heap.push(source, 0);
      while (heap.size > 0) {
        const [v, d] = heap.pop();
        if (d > dist[v]!) continue;
        if (v === sink) break;
        const edges = this.graph[v]!;
        for (let i = 0; i < edges.length; i++) {
          const e = edges[i]!;
          if (e.cap <= 0) continue;
          const nd = d + e.cost + potential[v]! - potential[e.to]!;
          if (nd < dist[e.to]!) {
            dist[e.to] = nd;
            prevNode[e.to] = v;
            prevEdge[e.to] = i;
            heap.push(e.to, nd);
          }
        }
      }
      if (!isFinite(dist[sink]!)) break;

      for (let v = 0; v < n; v++) {
        if (isFinite(dist[v]!)) potential[v]! += dist[v]!;
      }

      let add = limit - flow;
      for (let v = sink; v !== source; v = prevNode[v]!) {
        add = Math.min(add, this.graph[prevNode[v]!]![prevEdge[v]!]!.cap);
      }
      for (let v = sink; v !== source; v = prevNode[v]!) {
        const e = this.graph[prevNode[v]!]![prevEdge[v]!]!;
        e.cap -= add;
        this.graph[v]![e.rev]!.cap += add;
        cost += add * e.cost;
      }
      flow += add;
    }
    return [flow, cost];
  }

  /** Nodes reachable from `source` via residual (cap > 0) edges. */
  reachableFrom(source: number): boolean[] {
    const n = this.graph.length;
    const seen = new Array<boolean>(n).fill(false);
    const stack = [source];
    seen[source] = true;
    while (stack.length > 0) {
      const v = stack.pop()!;
      for (const e of this.graph[v]!) {
        if (e.cap > 0 && !seen[e.to]) {
          seen[e.to] = true;
          stack.push(e.to);
        }
      }
    }
    return seen;
  }
}

class MinHeap {
  private nodes: number[] = [];
  private prios: number[] = [];

  get size(): number {
    return this.nodes.length;
  }

  push(node: number, prio: number): void {
    this.nodes.push(node);
    this.prios.push(prio);
    let i = this.nodes.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.prios[parent]! <= this.prios[i]!) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  pop(): [number, number] {
    const topNode = this.nodes[0]!;
    const topPrio = this.prios[0]!;
    const lastNode = this.nodes.pop()!;
    const lastPrio = this.prios.pop()!;
    if (this.nodes.length > 0) {
      this.nodes[0] = lastNode;
      this.prios[0] = lastPrio;
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        const right = left + 1;
        let smallest = i;
        if (
          left < this.nodes.length &&
          this.prios[left]! < this.prios[smallest]!
        ) {
          smallest = left;
        }
        if (
          right < this.nodes.length &&
          this.prios[right]! < this.prios[smallest]!
        ) {
          smallest = right;
        }
        if (smallest === i) break;
        this.swap(i, smallest);
        i = smallest;
      }
    }
    return [topNode, topPrio];
  }

  private swap(a: number, b: number): void {
    const tn = this.nodes[a]!;
    this.nodes[a] = this.nodes[b]!;
    this.nodes[b] = tn;
    const tp = this.prios[a]!;
    this.prios[a] = this.prios[b]!;
    this.prios[b] = tp;
  }
}
