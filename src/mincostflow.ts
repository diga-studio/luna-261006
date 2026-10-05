/**
 * 最小费用最大流（successive shortest paths + 势函数 Dijkstra）。
 * 成本使用 BigInt 精确比较。算法行为完全确定：
 * 邻接边按输入顺序排列，Dijkstra 按节点下标顺序扫描、仅在严格更小时松弛，
 * 因此相同输入必得相同结果。
 */
export interface FlowEdge {
  from: number;
  to: number;
  capacity: number;
  cost: bigint;
  /** 调用方附加的负载（例如题目索引），原样保留。 */
  payload?: unknown;
}

export interface FlowResult {
  /** 实际达到的流量；小于 requested 表示不可行。 */
  readonly flow: number;
  readonly totalCost: bigint;
  /** 每条输入边最终使用的流量（按输入顺序）。 */
  readonly used: readonly number[];
}

interface ResidualEdge {
  to: number;
  rev: number;
  capacity: number;
  cost: bigint;
  inputIndex: number; // -1 表示反向边
}

export function minCostFlow(
  nodeCount: number,
  source: number,
  sink: number,
  requested: number,
  edges: readonly FlowEdge[],
): FlowResult {
  const graph: ResidualEdge[][] = Array.from({ length: nodeCount }, () => []);

  edges.forEach((e, i) => {
    const forward: ResidualEdge = { to: e.to, rev: 0, capacity: e.capacity, cost: e.cost, inputIndex: i };
    const backward: ResidualEdge = { to: e.from, rev: 0, capacity: 0, cost: -e.cost, inputIndex: -1 };
    forward.rev = graph[e.to]!.length;
    backward.rev = graph[e.from]!.length;
    graph[e.from]!.push(forward);
    graph[e.to]!.push(backward);
  });

  const potential = new Array<bigint>(nodeCount).fill(0n);
  let flow = 0;
  let totalCost = 0n;

  while (flow < requested) {
    const dist = new Array<bigint>(nodeCount).fill(-1n); // -1 表示不可达
    const prevNode = new Array<number>(nodeCount).fill(-1);
    const prevEdge = new Array<number>(nodeCount).fill(-1);
    const done = new Array<boolean>(nodeCount).fill(false);
    dist[source] = 0n;

    for (;;) {
      let best = -1;
      for (let v = 0; v < nodeCount; v++) {
        if (!done[v] && dist[v]! >= 0n && (best === -1 || dist[v]! < dist[best]!)) {
          best = v;
        }
      }
      if (best === -1) break;
      done[best] = true;
      const edgesOfBest = graph[best]!;
      for (let i = 0; i < edgesOfBest.length; i++) {
        const e = edgesOfBest[i]!;
        if (e.capacity <= 0) continue;
        const nd = dist[best]! + e.cost + potential[best]! - potential[e.to]!;
        if (dist[e.to]! === -1n || nd < dist[e.to]!) {
          dist[e.to] = nd;
          prevNode[e.to] = best;
          prevEdge[e.to] = i;
        }
      }
    }

    if (dist[sink]! === -1n) break;

    for (let v = 0; v < nodeCount; v++) {
      if (dist[v]! >= 0n) potential[v] = potential[v]! + dist[v]!;
    }

    let add = requested - flow;
    for (let v = sink; v !== source; v = prevNode[v]!) {
      const e = graph[prevNode[v]!]![prevEdge[v]!]!;
      if (e.capacity < add) add = e.capacity;
    }
    for (let v = sink; v !== source; v = prevNode[v]!) {
      const u = prevNode[v]!;
      const i = prevEdge[v]!;
      const e = graph[u]![i]!;
      e.capacity -= add;
      graph[v]![e.rev]!.capacity += add;
      totalCost += BigInt(add) * e.cost;
    }
    flow += add;
  }

  const used = edges.map((e, i) => {
    const forward = graph[e.from]!.find((r) => r.inputIndex === i)!;
    return e.capacity - forward.capacity;
  });

  return { flow, totalCost, used };
}
