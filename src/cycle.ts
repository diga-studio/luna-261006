import type { EdgeInterval } from "./timeline";

/** 闭合物料路径见证：day 当天，path[0] -> ... -> path[k]（path[k] === path[0]）每条边都生效。 */
export interface CycleWitness {
  day: number;
  path: string[];
}

/** 编译期内部使用的边：物料已映射为整数下标，生命周期已映射为段下标区间 [segStart, segEnd)。 */
interface IndexedEdge {
  from: number;
  to: number;
  segStart: number;
  segEnd: number;
}

/**
 * 迭代版 Tarjan，计算有向图的强连通分量。
 * 返回每个节点的分量编号及各分量大小。
 */
function computeScc(
  nodeCount: number,
  adj: readonly (readonly number[])[],
): { compOf: Int32Array; compSizes: number[] } {
  const index = new Int32Array(nodeCount).fill(-1);
  const low = new Int32Array(nodeCount);
  const onStack = new Uint8Array(nodeCount);
  const compOf = new Int32Array(nodeCount).fill(-1);
  const compSizes: number[] = [];
  const stack: number[] = [];
  const callStack: number[] = []; // 交替存放 [node, childPtr]
  let nextIndex = 0;

  for (let seed = 0; seed < nodeCount; seed++) {
    if (index[seed] !== -1) continue;
    callStack.push(seed, 0);
    while (callStack.length > 0) {
      const v = callStack[callStack.length - 2]!;
      const ptr = callStack[callStack.length - 1]!;
      if (ptr === 0) {
        index[v] = nextIndex;
        low[v] = nextIndex;
        nextIndex++;
        stack.push(v);
        onStack[v] = 1;
      }
      const neighbors = adj[v]!;
      let recursed = false;
      let p = ptr;
      while (p < neighbors.length) {
        const w = neighbors[p]!;
        p++;
        if (index[w] === -1) {
          callStack[callStack.length - 1] = p;
          callStack.push(w, 0);
          recursed = true;
          break;
        }
        if (onStack[w] === 1 && index[w]! < low[v]!) {
          low[v] = index[w]!;
        }
      }
      if (recursed) continue;
      if (low[v] === index[v]) {
        const compId = compSizes.length;
        let size = 0;
        for (;;) {
          const w = stack.pop()!;
          onStack[w] = 0;
          compOf[w] = compId;
          size++;
          if (w === v) break;
        }
        compSizes.push(size);
      }
      callStack.pop();
      callStack.pop();
      if (callStack.length > 0) {
        const parent = callStack[callStack.length - 2]!;
        if (low[v]! < low[parent]!) low[parent] = low[v]!;
      }
    }
  }
  return { compOf, compSizes };
}

/** 在 comp 成员内部找一条 from -> to 的路径（含端点），用成员内部的边。 */
function findPathWithin(
  members: readonly number[],
  inComp: Uint8Array,
  from: number,
  to: number,
  adj: readonly (readonly number[])[],
): number[] | null {
  const parent = new Map<number, number>();
  const stack: number[] = [from];
  parent.set(from, from);
  while (stack.length > 0) {
    const v = stack.pop()!;
    if (v === to) {
      const path: number[] = [to];
      let cur = to;
      while (cur !== from) {
        cur = parent.get(cur)!;
        path.push(cur);
      }
      path.reverse();
      return path;
    }
    for (const w of adj[v]!) {
      if (inComp[w] === 1 && !parent.has(w)) {
        parent.set(w, v);
        stack.push(w);
      }
    }
  }
  return null;
}

/**
 * 判定一组带生命周期的边是否在某一天同时构成有向环。
 *
 * 算法：先把每条边的生命周期对齐到全体边界日切出的时间段上，再对时间段做分治。
 * 在覆盖 [lo, hi) 的递归节点上，所有“完整覆盖该区间”的边在区间内每天都生效，
 * 对它们（连同祖先区间传下来的边）做一次 SCC 检查：若成环，则环在区间每天成立，
 * 见证日取 boundaries[lo]。不完整的边继续向左右子区间递归。
 * 每条边最多出现在 O(log T) 个递归节点上。
 */
export function detectTemporalCycle(edges: readonly EdgeInterval[]): CycleWitness | null {
  if (edges.length === 0) return null;

  // 物料标识 -> 整数下标
  const ids: string[] = [];
  const idOf = new Map<string, number>();
  const intern = (name: string): number => {
    let id = idOf.get(name);
    if (id === undefined) {
      id = ids.length;
      ids.push(name);
      idOf.set(name, id);
    }
    return id;
  };
  for (const edge of edges) {
    intern(edge.from);
    intern(edge.to);
  }
  const nodeCount = ids.length;

  // 静态超图（合并所有时段的边）上做 SCC 剪枝：
  // 任何“某天成环”的环在静态超图中也是环，不在同一 SCC 内的边不可能参与。
  const staticAdj: number[][] = Array.from({ length: nodeCount }, () => []);
  for (const edge of edges) {
    staticAdj[idOf.get(edge.from)!]!.push(idOf.get(edge.to)!);
  }
  const staticScc = computeScc(nodeCount, staticAdj);
  let hasCandidate = false;
  for (const edge of edges) {
    const from = idOf.get(edge.from)!;
    const to = idOf.get(edge.to)!;
    if (staticScc.compOf[from] === staticScc.compOf[to]) {
      hasCandidate = true;
      break;
    }
  }
  if (!hasCandidate) return null;

  // 全体边界日（有限端点）排序去重；段 i 为 [boundaries[i], boundaries[i+1])，
  // 最后一段为 [boundaries[n-1], Infinity)。段内边集合恒定。
  const boundarySet = new Set<number>();
  for (const edge of edges) {
    boundarySet.add(edge.startDay);
    if (edge.endDay !== Infinity) boundarySet.add(edge.endDay);
  }
  const boundaries = [...boundarySet].sort((a, b) => a - b);
  const segCount = boundaries.length;
  const segIndexOf = new Map<number, number>();
  boundaries.forEach((day, i) => segIndexOf.set(day, i));

  // 为候选边计算段区间 [segStart, segEnd)
  const indexed: IndexedEdge[] = [];
  for (const edge of edges) {
    const from = idOf.get(edge.from)!;
    const to = idOf.get(edge.to)!;
    if (staticScc.compOf[from] !== staticScc.compOf[to]) continue;
    const segStart = segIndexOf.get(edge.startDay)!;
    const segEnd = edge.endDay === Infinity ? segCount : segIndexOf.get(edge.endDay)!;
    indexed.push({ from, to, segStart, segEnd });
  }

  // 供 Tarjan 使用的局部下标映射（用后即还原，避免每次分配 nodeCount 大小的数组）
  const localOf = new Int32Array(nodeCount).fill(-1);

  /** 对一组在区间内每天生效的边做 SCC 检查；成环则返回见证。 */
  const checkFullEdges = (full: readonly IndexedEdge[], lo: number): CycleWitness | null => {
    const localNodes: number[] = [];
    const getLocal = (global: number): number => {
      let local = localOf[global]!;
      if (local === -1) {
        local = localNodes.length;
        localOf[global] = local;
        localNodes.push(global);
      }
      return local;
    };
    for (const edge of full) {
      getLocal(edge.from);
      getLocal(edge.to);
    }
    const localCount = localNodes.length;
    const adj: number[][] = Array.from({ length: localCount }, () => []);
    for (const edge of full) {
      adj[localOf[edge.from]!]!.push(localOf[edge.to]!);
    }
    const { compOf, compSizes } = computeScc(localCount, adj);
    let witness: CycleWitness | null = null;
    // 找一个非平凡 SCC（大小 > 1，或大小为 1 但带自环）
    for (let comp = 0; comp < compSizes.length && witness === null; comp++) {
      const isNontrivial = compSizes[comp]! > 1;
      const members: number[] = [];
      for (let v = 0; v < localCount; v++) {
        if (compOf[v] === comp) members.push(v);
      }
      let hasCycle = isNontrivial;
      if (!hasCycle) {
        const only = members[0]!;
        for (const w of adj[only]!) {
          if (w === only) {
            hasCycle = true;
            break;
          }
        }
      }
      if (!hasCycle) continue;
      const inComp = new Uint8Array(localCount);
      for (const v of members) inComp[v] = 1;
      // 取环上一条内部边 (u, v)，环 = u -> v 接上 v ~> u 的路径
      let u = -1;
      let v = -1;
      outer: for (const a of members) {
        for (const b of adj[a]!) {
          if (inComp[b] === 1) {
            u = a;
            v = b;
            break outer;
          }
        }
      }
      const mid = u === v ? [u] : findPathWithin(members, inComp, v, u, adj)!;
      const cycleLocal = [u, ...mid];
      const day = boundaries[lo]!;
      witness = {
        day,
        path: cycleLocal.map((local) => ids[localNodes[local]!]!),
      };
    }
    for (const global of localNodes) localOf[global] = -1;
    return witness;
  };

  const solve = (
    lo: number,
    hi: number,
    inherited: readonly IndexedEdge[],
    partial: readonly IndexedEdge[],
  ): CycleWitness | null => {
    if (partial.length === 0) return null; // inherited 已在父节点验证无环
    const full: IndexedEdge[] = [];
    const rest: IndexedEdge[] = [];
    for (const edge of partial) {
      if (edge.segStart <= lo && edge.segEnd >= hi) full.push(edge);
      else rest.push(edge);
    }
    let allFull: readonly IndexedEdge[] = inherited;
    if (full.length > 0) {
      allFull = inherited.length === 0 ? full : inherited.concat(full);
      const witness = checkFullEdges(allFull, lo);
      if (witness !== null) return witness;
    }
    if (hi - lo <= 1) return null;
    const mid = (lo + hi) >> 1;
    const left: IndexedEdge[] = [];
    const right: IndexedEdge[] = [];
    for (const edge of rest) {
      if (edge.segStart < mid && edge.segEnd > lo) left.push(edge);
      if (edge.segStart < hi && edge.segEnd > mid) right.push(edge);
    }
    return solve(lo, mid, allFull, left) ?? solve(mid, hi, allFull, right);
  };

  return solve(0, segCount, [], indexed);
}
