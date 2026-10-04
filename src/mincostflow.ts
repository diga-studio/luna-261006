/**
 * 最小费用流：successive shortest paths，SPFA 处理负费用边。
 * 费用使用 bigint，避免字典序大 M 权重溢出。
 * 每次增广 1 个单位流量（源点出边容量均为 1 时效率足够）。
 */

interface InternalEdge {
  to: number;
  rev: number;
  capacity: number;
  readonly originalCapacity: number;
  cost: bigint;
}

export interface FlowEdge {
  from: number;
  to: number;
  capacity: number;
  cost: bigint;
}

export class MinCostFlow {
  private readonly graph: InternalEdge[][];
  private readonly edgeLocations: Array<{ node: number; index: number }> = [];

  constructor(private readonly nodeCount: number) {
    this.graph = Array.from({ length: nodeCount }, () => []);
  }

  addEdge(edge: FlowEdge): void {
    const forward: InternalEdge = {
      to: edge.to,
      rev: this.graph[edge.to].length,
      capacity: edge.capacity,
      originalCapacity: edge.capacity,
      cost: edge.cost,
    };
    const backward: InternalEdge = {
      to: edge.from,
      rev: this.graph[edge.from].length,
      capacity: 0,
      originalCapacity: 0,
      cost: -edge.cost,
    };
    this.graph[edge.from].push(forward);
    this.graph[edge.to].push(backward);
    this.edgeLocations.push({ node: edge.from, index: this.graph[edge.from].length - 1 });
  }

  /** 求 source→sink 流量不超过 maxFlow 的最小费用流；返回实际流量。 */
  solve(source: number, sink: number, maxFlow: number): number {
    let flow = 0;
    while (flow < maxFlow) {
      const path = this.shortestPath(source, sink);
      if (path === null) break;
      let bottleneck = maxFlow - flow;
      for (const { node, index } of path) {
        bottleneck = Math.min(bottleneck, this.graph[node][index].capacity);
      }
      for (const { node, index } of path) {
        const edge = this.graph[node][index];
        edge.capacity -= bottleneck;
        this.graph[edge.to][edge.rev].capacity += bottleneck;
      }
      flow += bottleneck;
    }
    return flow;
  }

  /** 求解后查询某条边（按添加顺序的下标）的流量。 */
  flowOn(edgeIndex: number): number {
    const { node, index } = this.edgeLocations[edgeIndex];
    const edge = this.graph[node][index];
    return edge.originalCapacity - edge.capacity;
  }

  /** SPFA 最短路；返回途经边（node = 边起点, index = 边在邻接表中的下标），不可达返回 null。 */
  private shortestPath(
    source: number,
    sink: number,
  ): Array<{ node: number; index: number }> | null {
    const dist = new Array<bigint>(this.nodeCount);
    const inQueue = new Array<boolean>(this.nodeCount).fill(false);
    const prevNode = new Array<number>(this.nodeCount).fill(-1);
    const prevIndex = new Array<number>(this.nodeCount).fill(-1);
    dist[source] = 0n;
    const queue: number[] = [source];
    inQueue[source] = true;
    while (queue.length > 0) {
      const u = queue.shift() as number;
      inQueue[u] = false;
      for (let i = 0; i < this.graph[u].length; i++) {
        const edge = this.graph[u][i];
        if (edge.capacity <= 0) continue;
        const next = dist[u] + edge.cost;
        if (dist[edge.to] === undefined || next < dist[edge.to]) {
          dist[edge.to] = next;
          prevNode[edge.to] = u;
          prevIndex[edge.to] = i;
          if (!inQueue[edge.to]) {
            queue.push(edge.to);
            inQueue[edge.to] = true;
          }
        }
      }
    }
    if (dist[sink] === undefined) return null;
    const path: Array<{ node: number; index: number }> = [];
    for (let v = sink; v !== source; v = prevNode[v]) {
      path.push({ node: prevNode[v], index: prevIndex[v] });
    }
    return path;
  }
}
