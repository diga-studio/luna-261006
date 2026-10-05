/**
 * 带上下界的可行循环流：每条边流量 f 满足 lower <= f <= upper（均为整数），
 * 且每个节点流入等于流出。若需要“源点出发、汇点吸收”的普通流，
 * 调用方自行加一条汇点到源点的 [0, +∞) 边即可化为循环流。
 * 返回每条原始边的流量（与输入顺序一致）；不可行时返回 null。
 */
export interface FlowEdge {
  from: number;
  to: number;
  lower: bigint;
  upper: bigint;
}

interface Arc {
  to: number;
  rev: number;
  cap: bigint;
}

class Dinic {
  private graph: Arc[][] = [];
  private level: number[] = [];
  private iter: number[] = [];

  constructor(private n: number) {
    for (let i = 0; i < n; i++) this.graph.push([]);
  }

  addEdge(from: number, to: number, cap: bigint): number {
    const g = this.graph;
    const index = g[from]!.length;
    g[from]!.push({ to, rev: g[to]!.length, cap });
    g[to]!.push({ to: from, rev: g[from]!.length - 1, cap: 0n });
    return index;
  }

  private bfs(s: number, t: number): boolean {
    this.level = new Array<number>(this.n).fill(-1);
    const queue: number[] = [s];
    this.level[s] = 0;
    for (let head = 0; head < queue.length; head++) {
      const v = queue[head]!;
      for (const arc of this.graph[v]!) {
        if (arc.cap > 0n && this.level[arc.to]! < 0) {
          this.level[arc.to] = this.level[v]! + 1;
          queue.push(arc.to);
        }
      }
    }
    return this.level[t]! >= 0;
  }

  private dfs(v: number, t: number, f: bigint): bigint {
    if (v === t) return f;
    const g = this.graph[v]!;
    for (; this.iter[v]! < g.length; this.iter[v]!++) {
      const arc = g[this.iter[v]!]!;
      if (arc.cap > 0n && this.level[v]! < this.level[arc.to]!) {
        const d = this.dfs(arc.to, t, f < arc.cap ? f : arc.cap);
        if (d > 0n) {
          arc.cap -= d;
          this.graph[arc.to]![arc.rev]!.cap += d;
          return d;
        }
      }
    }
    return 0n;
  }

  maxFlow(s: number, t: number): bigint {
    let flow = 0n;
    while (this.bfs(s, t)) {
      this.iter = new Array<number>(this.n).fill(0);
      for (;;) {
        const f = this.dfs(s, t, 1n << 62n);
        if (f === 0n) break;
        flow += f;
      }
    }
    return flow;
  }

  /** 正向边当前流量（即反向边容量） */
  flowOn(from: number, arcIndex: number): bigint {
    const arc = this.graph[from]![arcIndex]!;
    return this.graph[arc.to]![arc.rev]!.cap;
  }
}

export function feasibleFlow(nodeCount: number, edges: FlowEdge[]): bigint[] | null {
  const ss = nodeCount;
  const tt = nodeCount + 1;
  const dinic = new Dinic(nodeCount + 2);
  const balance = new Array<bigint>(nodeCount).fill(0n);

  const arcIndex: number[] = [];
  for (const e of edges) {
    if (e.lower < 0n || e.upper < e.lower) return null;
    balance[e.from]! -= e.lower;
    balance[e.to]! += e.lower;
    arcIndex.push(dinic.addEdge(e.from, e.to, e.upper - e.lower));
  }

  let need = 0n;
  for (let v = 0; v < nodeCount; v++) {
    const b = balance[v]!;
    if (b > 0n) {
      dinic.addEdge(ss, v, b);
      need += b;
    } else if (b < 0n) {
      dinic.addEdge(v, tt, -b);
    }
  }

  if (dinic.maxFlow(ss, tt) !== need) return null;

  return edges.map((e, i) => e.lower + dinic.flowOn(e.from, arcIndex[i]!));
}
