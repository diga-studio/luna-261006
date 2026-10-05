/** 带下界 [lo, hi] 的边；所有界为整数（已按公分母放大）。 */
export interface BoundedEdge {
  from: number;
  to: number;
  lo: bigint;
  hi: bigint;
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

  constructor(nodeCount: number) {
    for (let i = 0; i < nodeCount; i++) this.graph.push([]);
    this.level = new Array<number>(nodeCount).fill(-1);
    this.iter = new Array<number>(nodeCount).fill(0);
  }

  /** 返回正向弧在 graph[from] 中的下标，便于事后读取剩余容量。 */
  addEdge(from: number, to: number, cap: bigint): number {
    const fwd: Arc = { to, rev: this.graph[to]!.length, cap };
    const rev: Arc = { to: from, rev: this.graph[from]!.length, cap: 0n };
    this.graph[from]!.push(fwd);
    this.graph[to]!.push(rev);
    return this.graph[from]!.length - 1;
  }

  residualCap(from: number, slot: number): bigint {
    return this.graph[from]![slot]!.cap;
  }

  private bfs(s: number, t: number): boolean {
    this.level.fill(-1);
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
    const arcs = this.graph[v]!;
    for (; this.iter[v]! < arcs.length; this.iter[v]!++) {
      const arc = arcs[this.iter[v]!]!;
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
    for (;;) {
      if (!this.bfs(s, t)) return flow;
      this.iter = new Array<number>(this.graph.length).fill(0);
      for (;;) {
        const f = this.dfs(s, t, BigInt("9223372036854775807"));
        if (f === 0n) break;
        flow += f;
      }
    }
  }
}

/**
 * 在 nodeCount 个节点的网络上求满足所有边下界/上界、且每个节点流量守恒的
 * 可行循环流。返回每条边（按输入顺序）的实际流量；无可行解时返回 null。
 *
 * 若需要源汇结构，调用方应自行加入一条汇到源的大容量边。
 */
export function feasibleFlow(nodeCount: number, edges: BoundedEdge[]): bigint[] | null {
  const ss = nodeCount;
  const tt = nodeCount + 1;
  const dinic = new Dinic(nodeCount + 2);
  const balance: bigint[] = new Array<bigint>(nodeCount).fill(0n);
  const slots: number[] = [];

  for (const e of edges) {
    if (e.lo < 0n || e.hi < e.lo) throw new Error("invalid edge bounds");
    slots.push(dinic.addEdge(e.from, e.to, e.hi - e.lo));
    balance[e.from] = balance[e.from]! - e.lo;
    balance[e.to] = balance[e.to]! + e.lo;
  }

  let total = 0n;
  for (let v = 0; v < nodeCount; v++) {
    const b = balance[v]!;
    if (b > 0n) {
      dinic.addEdge(ss, v, b);
      total += b;
    } else if (b < 0n) {
      dinic.addEdge(v, tt, -b);
    }
  }

  if (dinic.maxFlow(ss, tt) !== total) return null;

  return edges.map((e, i) => e.hi - dinic.residualCap(e.from, slots[i]!));
}
