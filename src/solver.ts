export interface FlowEdge {
  to: number;
  capacity: number;
  cost: number;
}

interface InternalEdge {
  to: number;
  rev: number;
  capacity: number;
  cost: number;
}

export interface FlowResult {
  maxFlow: number;
  minCost: number;
  /** Flow pushed through each input edge, same order as `edges`. */
  edgeFlows: number[];
}

/**
 * Min-cost max-flow over a directed graph.
 *
 * Successive shortest augmenting paths (SPFA). Edge costs must be
 * non-negative so the first shortest-path computation is correct.
 */
export function minCostMaxFlow(
  nodeCount: number,
  source: number,
  sink: number,
  edges: Array<{ from: number } & FlowEdge>
): FlowResult {
  const graph: InternalEdge[][] = Array.from({ length: nodeCount }, () => []);
  const forwardRefs: Array<{ node: number; index: number }> = [];
  for (const edge of edges) {
    forwardRefs.push({ node: edge.from, index: graph[edge.from].length });
    graph[edge.from].push({ to: edge.to, rev: graph[edge.to].length, capacity: edge.capacity, cost: edge.cost });
    graph[edge.to].push({ to: edge.from, rev: graph[edge.from].length - 1, capacity: 0, cost: -edge.cost });
  }

  let maxFlow = 0;
  let minCost = 0;

  for (;;) {
    const dist = new Array<number>(nodeCount).fill(Infinity);
    const inQueue = new Array<boolean>(nodeCount).fill(false);
    const prevNode = new Array<number>(nodeCount).fill(-1);
    const prevEdge = new Array<number>(nodeCount).fill(-1);
    dist[source] = 0;
    const queue: number[] = [source];
    inQueue[source] = true;

    while (queue.length > 0) {
      const node = queue.shift()!;
      inQueue[node] = false;
      for (let i = 0; i < graph[node].length; i++) {
        const edge = graph[node][i];
        if (edge.capacity <= 0) continue;
        const next = dist[node] + edge.cost;
        if (next < dist[edge.to]) {
          dist[edge.to] = next;
          prevNode[edge.to] = node;
          prevEdge[edge.to] = i;
          if (!inQueue[edge.to]) {
            queue.push(edge.to);
            inQueue[edge.to] = true;
          }
        }
      }
    }

    if (dist[sink] === Infinity) break;

    let aug = Infinity;
    for (let node = sink; node !== source; node = prevNode[node]) {
      aug = Math.min(aug, graph[prevNode[node]][prevEdge[node]].capacity);
    }
    for (let node = sink; node !== source; node = prevNode[node]) {
      const edge = graph[prevNode[node]][prevEdge[node]];
      edge.capacity -= aug;
      graph[node][edge.rev].capacity += aug;
    }
    maxFlow += aug;
    minCost += aug * dist[sink];
  }

  const edgeFlows = edges.map((edge, i) => {
    const ref = forwardRefs[i];
    return edge.capacity - graph[ref.node][ref.index].capacity;
  });

  return { maxFlow, minCost, edgeFlows };
}
