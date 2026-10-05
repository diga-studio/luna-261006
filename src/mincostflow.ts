interface Edge {
  to: number;
  rev: number;
  cap: number;
  originalCap: number;
  cost: number;
}

/** Result of a min-cost max-flow run on the assignment network. */
export interface FlowResult {
  /** Total units pushed from source to sink. */
  flow: number;
  /** Total cost of the flow. */
  cost: number;
}

/**
 * Successive-shortest-paths min-cost flow. Edge costs must be non-negative;
 * augmenting continues until no source->sink path remains, so the resulting
 * flow is a maximum flow of minimum cost.
 */
export class MinCostFlow {
  private readonly graph: Edge[][];
  private readonly potential: number[];

  constructor(private readonly nodeCount: number) {
    this.graph = Array.from({ length: nodeCount }, () => []);
    this.potential = new Array<number>(nodeCount).fill(0);
  }

  /** Adds a directed edge; returns its index in the `from` adjacency list. */
  addEdge(from: number, to: number, cap: number, cost: number): number {
    const forward: Edge = {
      to,
      rev: this.graph[to]!.length,
      cap,
      originalCap: cap,
      cost,
    };
    const backward: Edge = {
      to: from,
      rev: this.graph[from]!.length,
      cap: 0,
      originalCap: 0,
      cost: -cost,
    };
    this.graph[from]!.push(forward);
    this.graph[to]!.push(backward);
    return this.graph[from]!.length - 1;
  }

  /** Flow currently sent through the edge added at `from`/`edgeIndex`. */
  flowOn(from: number, edgeIndex: number): number {
    const edge = this.graph[from]![edgeIndex]!;
    return edge.originalCap - edge.cap;
  }

  /** Nodes reachable from `start` in the residual graph. */
  reachableFrom(start: number): boolean[] {
    const seen = new Array<boolean>(this.nodeCount).fill(false);
    const stack = [start];
    seen[start] = true;
    while (stack.length > 0) {
      const node = stack.pop()!;
      for (const edge of this.graph[node]!) {
        if (edge.cap > 0 && !seen[edge.to]) {
          seen[edge.to] = true;
          stack.push(edge.to);
        }
      }
    }
    return seen;
  }

  /** Augment while a source->sink path exists; returns achieved flow/cost. */
  solve(source: number, sink: number): FlowResult {
    let flow = 0;
    let cost = 0;
    const dist = new Array<number>(this.nodeCount);
    const prevNode = new Array<number>(this.nodeCount);
    const prevEdge = new Array<number>(this.nodeCount);
    // Binary heap of [distance, node] pairs.
    const heapKeys: number[] = [];
    const heapNodes: number[] = [];
    const push = (key: number, node: number): void => {
      heapKeys.push(key);
      heapNodes.push(node);
      let i = heapKeys.length - 1;
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (heapKeys[parent]! <= heapKeys[i]!) break;
        [heapKeys[parent], heapKeys[i]] = [heapKeys[i]!, heapKeys[parent]!];
        [heapNodes[parent], heapNodes[i]] = [heapNodes[i]!, heapNodes[parent]!];
        i = parent;
      }
    };
    const pop = (): number => {
      const top = heapNodes[0]!;
      const lastKey = heapKeys.pop()!;
      const lastNode = heapNodes.pop()!;
      if (heapKeys.length > 0) {
        heapKeys[0] = lastKey;
        heapNodes[0] = lastNode;
        let i = 0;
        for (;;) {
          const left = i * 2 + 1;
          const right = left + 1;
          let smallest = i;
          if (heapKeys[left]! < heapKeys[smallest]!) smallest = left;
          if (heapKeys[right]! < heapKeys[smallest]!) smallest = right;
          if (smallest === i) break;
          [heapKeys[smallest], heapKeys[i]] = [heapKeys[i]!, heapKeys[smallest]!];
          [heapNodes[smallest], heapNodes[i]] = [heapNodes[i]!, heapNodes[smallest]!];
          i = smallest;
        }
      }
      return top;
    };

    for (;;) {
      dist.fill(Number.POSITIVE_INFINITY);
      dist[source] = 0;
      push(0, source);
      while (heapKeys.length > 0) {
        const node = pop();
        const d = dist[node]!;
        const edges = this.graph[node]!;
        for (let i = 0; i < edges.length; i += 1) {
          const edge = edges[i]!;
          if (edge.cap <= 0) continue;
          const next =
            d + edge.cost + this.potential[node]! - this.potential[edge.to]!;
          if (next < dist[edge.to]!) {
            dist[edge.to] = next;
            prevNode[edge.to] = node;
            prevEdge[edge.to] = i;
            push(next, edge.to);
          }
        }
      }
      if (!Number.isFinite(dist[sink]!)) break;
      for (let node = 0; node < this.nodeCount; node += 1) {
        if (Number.isFinite(dist[node]!)) {
          this.potential[node]! += dist[node]!;
        }
      }
      // Bottleneck of the augmenting path.
      let add = Number.POSITIVE_INFINITY;
      for (let node = sink; node !== source; node = prevNode[node]!) {
        const edge = this.graph[prevNode[node]!]![prevEdge[node]!]!;
        if (edge.cap < add) add = edge.cap;
      }
      for (let node = sink; node !== source; node = prevNode[node]!) {
        const edge = this.graph[prevNode[node]!]![prevEdge[node]!]!;
        edge.cap -= add;
        this.graph[node]![edge.rev]!.cap += add;
        cost += add * edge.cost;
      }
      flow += add;
    }
    return { flow, cost };
  }
}
