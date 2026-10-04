/**
 * 最小费用流（连续最短增广路 SSP + 势函数 Dijkstra）。
 *
 * 仅供内部分摊求解器使用：容量与流量为非负整数（number），
 * 单位费用为 bigint，可正可负可零。
 */

/** 一条有向边的输入描述。 */
export interface FlowEdgeInput {
  readonly from: number;
  readonly to: number;
  /** 非负整数容量。 */
  readonly capacity: number;
  /** 单位流量费用。 */
  readonly cost: bigint;
}

interface Arc {
  to: number;
  /** 在反向邻接表中的下标。 */
  rev: number;
  /** 剩余容量。 */
  cap: number;
  cost: bigint;
}

/**
 * 求从 source 到 sink 恰好推送 requiredFlow 单位流量的最小费用流。
 * 返回与输入边一一对应的流量数组（非负整数）。
 * 若无法推送足够流量则抛出 Error。
 */
export function minCostFlow(
  nodeCount: number,
  edges: readonly FlowEdgeInput[],
  source: number,
  sink: number,
  requiredFlow: number,
): number[] {
  if (requiredFlow < 0) {
    throw new Error("minCostFlow: requiredFlow must be non-negative");
  }
  const graph: Arc[][] = Array.from({ length: nodeCount }, () => []);
  const inputArcIndex: number[] = [];
  for (const edge of edges) {
    if (edge.capacity < 0) {
      throw new Error("minCostFlow: capacity must be non-negative");
    }
    const forward: Arc = {
      to: edge.to,
      rev: graph[edge.to]!.length,
      cap: edge.capacity,
      cost: edge.cost,
    };
    const backward: Arc = {
      to: edge.from,
      rev: graph[edge.from]!.length,
      cap: 0,
      cost: -edge.cost,
    };
    graph[edge.from]!.push(forward);
    graph[edge.to]!.push(backward);
    inputArcIndex.push(graph[edge.from]!.length - 1);
  }

  // 初始势函数：Bellman-Ford，使所有约化费用非负（允许负费用输入边）。
  const potential: bigint[] = new Array<bigint>(nodeCount).fill(0n);
  for (let round = 0; round < nodeCount - 1; round++) {
    let updated = false;
    for (let u = 0; u < nodeCount; u++) {
      for (const arc of graph[u]!) {
        if (arc.cap > 0 && potential[arc.to]! > potential[u]! + arc.cost) {
          potential[arc.to] = potential[u]! + arc.cost;
          updated = true;
        }
      }
    }
    if (!updated) break;
  }

  let flow = 0;
  while (flow < requiredFlow) {
    // Dijkstra（O(V^2) 朴素实现，节点数很小）：在约化费用上找最短路。
    const dist: (bigint | null)[] = new Array<bigint | null>(nodeCount).fill(null);
    const prevNode: number[] = new Array<number>(nodeCount).fill(-1);
    const prevArc: number[] = new Array<number>(nodeCount).fill(-1);
    const done: boolean[] = new Array<boolean>(nodeCount).fill(false);
    dist[source] = 0n;
    for (;;) {
      let u = -1;
      let best: bigint | null = null;
      for (let i = 0; i < nodeCount; i++) {
        const d = dist[i]!;
        if (!done[i] && d !== null && (best === null || d < best)) {
          u = i;
          best = d;
        }
      }
      if (u === -1) break;
      done[u] = true;
      const arcs = graph[u]!;
      for (let j = 0; j < arcs.length; j++) {
        const arc = arcs[j]!;
        if (arc.cap <= 0) continue;
        const reduced = arc.cost + potential[u]! - potential[arc.to]!;
        const next = dist[u]! + reduced;
        const current = dist[arc.to]!;
        if (current === null || next < current) {
          dist[arc.to] = next;
          prevNode[arc.to] = u;
          prevArc[arc.to] = j;
        }
      }
    }
    if (dist[sink] === null) {
      throw new Error(
        `minCostFlow: infeasible, pushed ${flow} of ${requiredFlow}`,
      );
    }
    for (let v = 0; v < nodeCount; v++) {
      if (dist[v] !== null) potential[v] = potential[v]! + dist[v]!;
    }

    // 沿最短路按瓶颈容量增广。
    let add = requiredFlow - flow;
    for (let v = sink; v !== source; v = prevNode[v]!) {
      const arc = graph[prevNode[v]!]![prevArc[v]!]!;
      if (arc.cap < add) add = arc.cap;
    }
    for (let v = sink; v !== source; v = prevNode[v]!) {
      const arc = graph[prevNode[v]!]![prevArc[v]!]!;
      arc.cap -= add;
      graph[v]![arc.rev]!.cap += add;
    }
    flow += add;
  }

  // 输入边的流量 = 其反向弧的剩余容量。
  return edges.map((edge, i) => {
    const forward = graph[edge.from]![inputArcIndex[i]!]!;
    return graph[forward.to]![forward.rev]!.cap;
  });
}
