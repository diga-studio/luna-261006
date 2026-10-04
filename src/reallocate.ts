import type { Device, LicensePool, ReallocationResult } from './types.js';

/** 费用流图的边 */
interface FlowEdge {
  to: number;
  capacity: number;
  cost: number;
  /** 在邻接表中的反向边索引 */
  reverse: number;
}

class FlowGraph {
  private readonly adjacency: FlowEdge[][] = [];

  addNode(): number {
    this.adjacency.push([]);
    return this.adjacency.length - 1;
  }

  /** 返回正向边在 adjacency[from] 中的索引 */
  addEdge(from: number, to: number, capacity: number, cost: number): number {
    const forward: FlowEdge = { to, capacity, cost, reverse: this.adjacency[to].length };
    const backward: FlowEdge = { to: from, capacity: 0, cost: -cost, reverse: this.adjacency[from].length };
    this.adjacency[from].push(forward);
    this.adjacency[to].push(backward);
    return this.adjacency[from].length - 1;
  }

  edge(node: number, index: number): FlowEdge {
    return this.adjacency[node][index];
  }

  /**
   * 连续最短路增广：在取得最大流的所有方案中使总费用最小。
   * 使用 Johnson 势能 + Dijkstra 处理残余网络中的负费用边。
   */
  minCostMaxFlow(source: number, sink: number): void {
    const nodeCount = this.adjacency.length;
    const potential = new Array<number>(nodeCount).fill(0);

    for (;;) {
      const dist = new Array<number>(nodeCount).fill(Infinity);
      const prevNode = new Array<number>(nodeCount).fill(-1);
      const prevEdge = new Array<number>(nodeCount).fill(-1);
      dist[source] = 0;

      // 简单二叉堆
      const heap: Array<[number, number]> = [[0, source]];
      const push = (priority: number, node: number): void => {
        heap.push([priority, node]);
        let i = heap.length - 1;
        while (i > 0) {
          const parent = (i - 1) >> 1;
          if (heap[parent][0] <= heap[i][0]) break;
          [heap[parent], heap[i]] = [heap[i], heap[parent]];
          i = parent;
        }
      };
      const pop = (): [number, number] | undefined => {
        if (heap.length === 0) return undefined;
        const top = heap[0];
        const last = heap.pop()!;
        if (heap.length > 0) {
          heap[0] = last;
          let i = 0;
          for (;;) {
            const left = i * 2 + 1;
            const right = left + 1;
            let smallest = i;
            if (left < heap.length && heap[left][0] < heap[smallest][0]) smallest = left;
            if (right < heap.length && heap[right][0] < heap[smallest][0]) smallest = right;
            if (smallest === i) break;
            [heap[smallest], heap[i]] = [heap[i], heap[smallest]];
            i = smallest;
          }
        }
        return top;
      };

      while (heap.length > 0) {
        const [d, u] = pop()!;
        if (d > dist[u]) continue;
        for (let i = 0; i < this.adjacency[u].length; i++) {
          const e = this.adjacency[u][i];
          if (e.capacity <= 0) continue;
          const nd = d + e.cost + potential[u] - potential[e.to];
          if (nd < dist[e.to]) {
            dist[e.to] = nd;
            prevNode[e.to] = u;
            prevEdge[e.to] = i;
            push(nd, e.to);
          }
        }
      }

      if (dist[sink] === Infinity) return;

      for (let v = 0; v < nodeCount; v++) {
        if (dist[v] < Infinity) potential[v] += dist[v];
      }

      // 本问题中所有源点出边容量为 1，每次增广流量恒为 1
      let v = sink;
      while (v !== source) {
        const u = prevNode[v];
        const e = this.adjacency[u][prevEdge[v]];
        e.capacity -= 1;
        this.adjacency[e.to][e.reverse].capacity += 1;
        v = u;
      }
    }
  }
}

/**
 * 对一款软件的按设备许可做席位重排。
 *
 * 目标（按优先级）：
 * 1. 使获得有效授权的设备总数最大；
 * 2. 在覆盖数最大的方案中，使保持原许可池绑定的设备数最多。
 *
 * 许可不足时返回最优的部分覆盖方案，不整批失败。
 */
export function reallocateSeats(
  devices: ReadonlyArray<Device>,
  pools: ReadonlyArray<LicensePool>,
  businessDate: string,
): ReallocationResult {
  const graph = new FlowGraph();
  const source = graph.addNode();
  const sink = graph.addNode();
  const deviceNodes = devices.map(() => graph.addNode());
  const poolNodes = pools.map(() => graph.addNode());

  // 设备 -> 池 的边位置，用于增广后读取流量
  const assignmentEdges: Array<{ deviceIndex: number; poolIndex: number; edgeIndex: number }> = [];

  for (let i = 0; i < devices.length; i++) {
    graph.addEdge(source, deviceNodes[i], 1, 0);
  }

  for (let j = 0; j < pools.length; j++) {
    const pool = pools[j];
    // 到期日当天仍有效；早于核算日的池不参与分配
    if (pool.expiresOn < businessDate) continue;
    if (pool.totalSeats <= 0) continue;
    const allowed = new Set(pool.allowedDepartments);
    for (let i = 0; i < devices.length; i++) {
      const device = devices[i];
      if (!allowed.has(device.department)) continue;
      // 保留原绑定费用为 0，换绑/新绑费用为 1：
      // 在覆盖数最大的方案中使保留数最多
      const preserved = device.previousPoolId != null && device.previousPoolId === pool.poolId;
      const edgeIndex = graph.addEdge(deviceNodes[i], poolNodes[j], 1, preserved ? 0 : 1);
      assignmentEdges.push({
        deviceIndex: i,
        poolIndex: j,
        edgeIndex,
      });
    }
    graph.addEdge(poolNodes[j], sink, pool.totalSeats, 0);
  }

  graph.minCostMaxFlow(source, sink);

  const assignments: Array<{ deviceId: string; poolId: string }> = [];
  const covered = new Array<boolean>(devices.length).fill(false);
  let preservedCount = 0;
  for (const { deviceIndex, poolIndex, edgeIndex } of assignmentEdges) {
    // 正向边容量从 1 降为 0 表示该设备经此边占用了一个席位
    const edge = graph.edge(deviceNodes[deviceIndex], edgeIndex);
    if (edge.capacity === 0) {
      covered[deviceIndex] = true;
      const device = devices[deviceIndex];
      if (device.previousPoolId != null && device.previousPoolId === pools[poolIndex].poolId) {
        preservedCount++;
      }
      assignments.push({
        deviceId: device.deviceId,
        poolId: pools[poolIndex].poolId,
      });
    }
  }

  const uncoveredDeviceIds: string[] = [];
  for (let i = 0; i < devices.length; i++) {
    if (!covered[i]) uncoveredDeviceIds.push(devices[i].deviceId);
  }

  return {
    assignments,
    uncoveredDeviceIds,
    coveredCount: assignments.length,
    preservedCount,
  };
}
