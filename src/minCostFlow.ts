/**
 * 最小费用流：连续最短路（SPFA）增广。
 * 图规模很小（节点数 = 科目数 + 部门数 + 2，流量 <= 科目数 * 部门数），
 * 因此不做势函数优化，直接每轮 SPFA 找最短路，允许负费用边。
 */

export interface McfEdge {
  from: number;
  to: number;
  capacity: number;
  cost: number;
}

export interface MinCostFlowResult {
  /** 与输入边一一对应的流量。 */
  flows: number[];
  /** 总费用。 */
  totalCost: number;
}

interface Arc {
  to: number;
  rev: number;
  cap: number;
  cost: number;
  /** 对应输入边下标，反向弧为 -1。 */
  edgeIndex: number;
}

export function minCostFlow(
  nodeCount: number,
  edges: readonly McfEdge[],
  source: number,
  sink: number,
  requiredFlow: number,
): MinCostFlowResult {
  const graph: Arc[][] = Array.from({ length: nodeCount }, () => []);
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    graph[e.from].push({ to: e.to, rev: graph[e.to].length, cap: e.capacity, cost: e.cost, edgeIndex: i });
    graph[e.to].push({ to: e.from, rev: graph[e.from].length - 1, cap: 0, cost: -e.cost, edgeIndex: -1 });
  }

  const flows = new Array<number>(edges.length).fill(0);
  let totalCost = 0;
  let sent = 0;

  while (sent < requiredFlow) {
    const dist = new Array<number>(nodeCount).fill(Infinity);
    const inQueue = new Array<boolean>(nodeCount).fill(false);
    const prevNode = new Array<number>(nodeCount).fill(-1);
    const prevArc = new Array<number>(nodeCount).fill(-1);
    dist[source] = 0;
    const queue: number[] = [source];
    inQueue[source] = true;
    while (queue.length > 0) {
      const u = queue.shift()!;
      inQueue[u] = false;
      for (let ai = 0; ai < graph[u].length; ai++) {
        const arc = graph[u][ai];
        if (arc.cap <= 0) continue;
        const nd = dist[u] + arc.cost;
        if (nd < dist[arc.to]) {
          dist[arc.to] = nd;
          prevNode[arc.to] = u;
          prevArc[arc.to] = ai;
          if (!inQueue[arc.to]) {
            queue.push(arc.to);
            inQueue[arc.to] = true;
          }
        }
      }
    }
    if (!isFinite(dist[sink])) {
      throw new Error(`minCostFlow: infeasible, sent ${sent} of ${requiredFlow}`);
    }
    let add = requiredFlow - sent;
    for (let v = sink; v !== source; v = prevNode[v]) {
      add = Math.min(add, graph[prevNode[v]][prevArc[v]].cap);
    }
    for (let v = sink; v !== source; v = prevNode[v]) {
      const u = prevNode[v];
      const arc = graph[u][prevArc[v]];
      arc.cap -= add;
      graph[v][arc.rev].cap += add;
      if (arc.edgeIndex >= 0) flows[arc.edgeIndex] += add;
      else flows[graph[v][arc.rev].edgeIndex] -= add;
    }
    totalCost += add * dist[sink];
    sent += add;
  }

  return { flows, totalCost };
}
