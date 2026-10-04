/**
 * Min-cost flow via successive shortest paths with Johnson potentials.
 *
 * Augmenting until no s-t path remains yields a maximum flow that is also
 * min-cost among all maximum flows (standard SSP argument: each
 * augmentation preserves min-cost optimality for the current flow value,
 * and the algorithm only stops at max flow). This gives the lexicographic
 * objective "maximize flow first, then minimize cost" without folding the
 * two objectives into a single weighted score.
 *
 * If every edge cost is non-negative the initial potentials are all zero
 * and no Bellman-Ford pass is needed; reduced costs then stay non-negative.
 */
interface Edge {
  to: number;
  rev: number;
  capacity: number;
  cost: number;
}

export class MinCostFlow {
  private readonly graph: Edge[][];
  private readonly edgeRefs: Array<[number, number]> = [];

  constructor(nodeCount: number) {
    this.graph = Array.from({ length: nodeCount }, () => []);
  }

  addEdge(from: number, to: number, capacity: number, cost: number): number {
    const forward: Edge = { to, rev: this.graph[to].length, capacity, cost };
    const backward: Edge = { to: from, rev: this.graph[from].length, capacity: 0, cost: -cost };
    this.graph[from].push(forward);
    this.graph[to].push(backward);
    this.edgeRefs.push([from, this.graph[from].length - 1]);
    return this.edgeRefs.length - 1;
  }

  /** Flow on the edge added as the index-th addEdge call. */
  flowOn(edgeIndex: number): number {
    const [from, pos] = this.edgeRefs[edgeIndex];
    const edge = this.graph[from][pos];
    return this.graph[edge.to][edge.rev].capacity;
  }

  /**
   * Augments along shortest paths until no s-t path exists.
   * Returns the maximum flow value and its minimum total cost.
   */
  minCostMaxFlow(source: number, sink: number): { flow: number; cost: number } {
    const n = this.graph.length;
    const potential = new Array<number>(n).fill(0);

    let hasNegative = false;
    for (const edges of this.graph) {
      for (const e of edges) {
        if (e.capacity > 0 && e.cost < 0) hasNegative = true;
      }
    }
    if (hasNegative) {
      const dist = new Array<number>(n).fill(Infinity);
      dist[source] = 0;
      for (let iter = 0; iter < n - 1; iter += 1) {
        let changed = false;
        for (let v = 0; v < n; v += 1) {
          if (dist[v] === Infinity) continue;
          for (const e of this.graph[v]) {
            if (e.capacity > 0 && dist[v] + e.cost < dist[e.to]) {
              dist[e.to] = dist[v] + e.cost;
              changed = true;
            }
          }
        }
        if (!changed) break;
      }
      for (let v = 0; v < n; v += 1) {
        if (dist[v] !== Infinity) potential[v] = dist[v];
      }
    }

    let flow = 0;
    let cost = 0;
    const dist = new Array<number>(n);
    const prevNode = new Array<number>(n);
    const prevEdge = new Array<number>(n);
    const heap: number[] = []; // interleaved [distance, node] pairs

    const heapPush = (d: number, v: number): void => {
      heap.push(d, v);
      let i = (heap.length >> 1) - 1;
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (heap[parent * 2] <= heap[i * 2]) break;
        for (const off of [0, 1]) {
          const tmp = heap[parent * 2 + off];
          heap[parent * 2 + off] = heap[i * 2 + off];
          heap[i * 2 + off] = tmp;
        }
        i = parent;
      }
    };
    const heapPop = (): void => {
      const lastD = heap[heap.length - 2];
      const lastV = heap[heap.length - 1];
      heap.length -= 2;
      if (heap.length === 0) return;
      heap[0] = lastD;
      heap[1] = lastV;
      let i = 0;
      const size = heap.length >> 1;
      for (;;) {
        const left = i * 2 + 1;
        const right = left + 1;
        let smallest = i;
        if (left < size && heap[left * 2] < heap[smallest * 2]) smallest = left;
        if (right < size && heap[right * 2] < heap[smallest * 2]) smallest = right;
        if (smallest === i) break;
        for (const off of [0, 1]) {
          const tmp = heap[smallest * 2 + off];
          heap[smallest * 2 + off] = heap[i * 2 + off];
          heap[i * 2 + off] = tmp;
        }
        i = smallest;
      }
    };

    for (;;) {
      dist.fill(Infinity);
      prevNode.fill(-1);
      dist[source] = 0;
      heap.length = 0;
      heapPush(0, source);
      while (heap.length > 0) {
        const d = heap[0];
        const v = heap[1];
        heapPop();
        if (d > dist[v]) continue; // stale heap entry
        const edges = this.graph[v];
        for (let i = 0; i < edges.length; i += 1) {
          const e = edges[i];
          if (e.capacity <= 0) continue;
          const nd = d + e.cost + potential[v] - potential[e.to];
          if (nd < dist[e.to]) {
            dist[e.to] = nd;
            prevNode[e.to] = v;
            prevEdge[e.to] = i;
            heapPush(nd, e.to);
          }
        }
      }
      if (dist[sink] === Infinity) break;

      for (let v = 0; v < n; v += 1) {
        if (dist[v] !== Infinity) potential[v] += dist[v];
      }

      let add = Infinity;
      for (let v = sink; v !== source; v = prevNode[v]) {
        add = Math.min(add, this.graph[prevNode[v]][prevEdge[v]].capacity);
      }
      for (let v = sink; v !== source; v = prevNode[v]) {
        const e = this.graph[prevNode[v]][prevEdge[v]];
        e.capacity -= add;
        this.graph[e.to][e.rev].capacity += add;
        cost += add * e.cost;
      }
      flow += add;
    }
    return { flow, cost };
  }
}
