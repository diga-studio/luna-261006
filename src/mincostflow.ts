/**
 * 最小费用最大流：逐次最短路（SSP）+ Johnson 势函数。
 *
 * 每次沿当前残量网络中费用最小的增广路增广，直到不存在增广路为止。
 * 由于初始残量网络无负环（初始流为 0，残量网络只有前向边），SSP 保证
 * 每个流量值下的流都是该流量下的最小费用流；增广到最大流后即得到
 * “先流量最大、再费用最小”的字典序最优解，无需用大常数混合两个目标。
 */
export class MinCostMaxFlow {
  private readonly nodeCount: number;
  // 边采用结构数组存储，to/cap/cost/next 为残量边，head 为邻接表头
  private readonly head: Int32Array;
  private readonly to: number[] = [];
  private readonly cap: number[] = [];
  private readonly cost: number[] = [];
  private readonly next: number[] = [];
  private readonly initCap: number[] = [];

  constructor(nodeCount: number) {
    this.nodeCount = nodeCount;
    this.head = new Int32Array(nodeCount).fill(-1);
  }

  /** 添加一条边；cost 允许为负。返回的边序号可用于 flowOn 查询。 */
  addEdge(from: number, to: number, capacity: number, cost: number): number {
    const fwd = this.to.length;
    this.pushEdge(from, to, capacity, cost);
    this.pushEdge(to, from, 0, -cost);
    return fwd >> 1;
  }

  private pushEdge(from: number, to: number, capacity: number, cost: number): void {
    this.to.push(to);
    this.cap.push(capacity);
    this.cost.push(cost);
    this.initCap.push(capacity);
    this.next.push(this.head[from]!);
    this.head[from] = this.to.length - 1;
  }

  /**
   * 返回 [maxFlow, minCost]：在保证流量最大的前提下使费用最小。
   */
  solve(source: number, sink: number): [number, number] {
    const n = this.nodeCount;
    const potential = this.initialPotentials(source);
    const dist = new Float64Array(n);
    const prevNode = new Int32Array(n);
    const prevEdge = new Int32Array(n);
    let flow = 0;
    let costSum = 0;

    while (true) {
      // Dijkstra（以势函数折算的非负费用）
      dist.fill(Infinity);
      dist[source] = 0;
      const heap = new MinHeap();
      heap.push(source, 0);
      while (heap.size > 0) {
        const [u, d] = heap.pop();
        if (d > dist[u]!) continue;
        for (let e = this.head[u]!; e !== -1; e = this.next[e]!) {
          if (this.cap[e]! <= 0) continue;
          const v = this.to[e]!;
          const w = this.cost[e]! + potential[u]! - potential[v]!;
          const nd = d + w;
          if (nd < dist[v]! - 1e-12) {
            dist[v] = nd;
            prevNode[v] = u;
            prevEdge[v] = e;
            heap.push(v, nd);
          }
        }
      }
      if (dist[sink] === Infinity) break;

      for (let v = 0; v < n; v += 1) {
        if (dist[v]! < Infinity) potential[v] = potential[v]! + dist[v]!;
      }

      // 无论最短路费用正负都继续增广：先保证流量最大
      let add = Infinity;
      for (let v = sink; v !== source; v = prevNode[v]!) {
        add = Math.min(add, this.cap[prevEdge[v]!]!);
      }
      for (let v = sink; v !== source; v = prevNode[v]!) {
        const e = prevEdge[v]!;
        this.cap[e] = this.cap[e]! - add;
        this.cap[e ^ 1] = this.cap[e ^ 1]! + add;
        costSum += add * this.cost[e]!;
      }
      flow += add;
    }
    return [flow, costSum];
  }

  /** Bellman-Ford 求初始势函数，使所有折算费用非负 */
  private initialPotentials(source: number): Float64Array {
    const n = this.nodeCount;
    const potential = new Float64Array(n).fill(Infinity);
    potential[source] = 0;
    for (let iter = 0; iter < n - 1; iter += 1) {
      let changed = false;
      for (let u = 0; u < n; u += 1) {
        if (potential[u] === Infinity) continue;
        for (let e = this.head[u]!; e !== -1; e = this.next[e]!) {
          if (this.cap[e]! <= 0) continue;
          const v = this.to[e]!;
          const nd = potential[u]! + this.cost[e]!;
          if (nd < potential[v]!) {
            potential[v] = nd;
            changed = true;
          }
        }
      }
      if (!changed) break;
    }
    // 不可达点的势保持 0 即可（其折算费用不影响正确性）
    for (let v = 0; v < n; v += 1) {
      if (potential[v] === Infinity) potential[v] = 0;
    }
    return potential;
  }

  /** 求解后查询第 index 条加入的边（addEdge 返回值）的流量 */
  flowOn(edgeIndex: number): number {
    const fwd = edgeIndex << 1;
    return this.initCap[fwd]! - this.cap[fwd]!;
  }
}

/** 简易二叉小根堆（节点, 优先级） */
class MinHeap {
  private readonly nodes: number[] = [];
  private readonly prios: number[] = [];

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
        const left = i * 2 + 1;
        const right = left + 1;
        let smallest = i;
        if (left < this.nodes.length && this.prios[left]! < this.prios[smallest]!) smallest = left;
        if (right < this.nodes.length && this.prios[right]! < this.prios[smallest]!) smallest = right;
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
