/**
 * 静态区间索引：按原素材标识分组，组内用居中区间树支持
 * “找出所有与查询区间有正长度交集的段”的范围查询。
 * 查询复杂度 O(log n + k)，k 为命中数；适配大量同源不相交短段
 * 与少量覆盖长段混用的场景。
 */

/** 索引中登记的一条区间（对应新版一个剪辑段的素材覆盖范围）。 */
export interface IndexedInterval<T> {
  readonly lo: number; // 素材坐标下界（含）
  readonly hi: number; // 素材坐标上界（不含）
  readonly payload: T;
}

interface TreeNode<T> {
  readonly center: number;
  /** 覆盖 center 的区间，按 lo 升序。 */
  readonly byLo: IndexedInterval<T>[];
  /** 覆盖 center 的区间，按 hi 降序。 */
  readonly byHi: IndexedInterval<T>[];
  readonly left: TreeNode<T> | null;
  readonly right: TreeNode<T> | null;
}

function buildTree<T>(intervals: IndexedInterval<T>[]): TreeNode<T> | null {
  if (intervals.length === 0) {
    return null;
  }
  // 以所有端点的中位数为中心，保证树高 O(log n)。
  const endpoints = new Array<number>(intervals.length * 2);
  for (let i = 0; i < intervals.length; i++) {
    endpoints[i * 2] = intervals[i]!.lo;
    endpoints[i * 2 + 1] = intervals[i]!.hi;
  }
  endpoints.sort((a, b) => a - b);
  const center = endpoints[(endpoints.length - 1) >> 1]!;

  const covering: IndexedInterval<T>[] = [];
  const leftList: IndexedInterval<T>[] = [];
  const rightList: IndexedInterval<T>[] = [];
  for (const iv of intervals) {
    if (iv.lo <= center && center <= iv.hi) {
      covering.push(iv);
    } else if (iv.hi < center) {
      leftList.push(iv);
    } else {
      rightList.push(iv);
    }
  }
  const byLo = covering.slice().sort((a, b) => a.lo - b.lo);
  const byHi = covering.slice().sort((a, b) => b.hi - a.hi);
  return {
    center,
    byLo,
    byHi,
    left: buildTree(leftList),
    right: buildTree(rightList),
  };
}

function queryTree<T>(node: TreeNode<T> | null, qLo: number, qHi: number, out: T[]): void {
  if (node === null) {
    return;
  }
  if (qHi <= node.center) {
    // 覆盖 center 的区间 hi > center >= qHi > qLo，只需 lo < qHi。
    const list = node.byLo;
    for (let i = 0; i < list.length && list[i]!.lo < qHi; i++) {
      out.push(list[i]!.payload);
    }
    queryTree(node.left, qLo, qHi, out);
    return;
  }
  if (qLo >= node.center) {
    // 覆盖 center 的区间 lo <= center <= qLo < qHi，只需 hi > qLo。
    const list = node.byHi;
    for (let i = 0; i < list.length && list[i]!.hi > qLo; i++) {
      out.push(list[i]!.payload);
    }
    queryTree(node.right, qLo, qHi, out);
    return;
  }
  // qLo < center < qHi：覆盖 center 的区间全部命中。
  for (const iv of node.byLo) {
    out.push(iv.payload);
  }
  queryTree(node.left, qLo, qHi, out);
  queryTree(node.right, qLo, qHi, out);
}

export class SourceIntervalIndex<T> {
  private readonly pending = new Map<string, IndexedInterval<T>[]>();
  private trees: Map<string, TreeNode<T> | null> | null = null;

  /** 登记一条区间；构建期调用，查询前必须先 finish()。 */
  add(sourceId: string, interval: IndexedInterval<T>): void {
    if (this.trees !== null) {
      throw new Error('cannot add after finish()');
    }
    let list = this.pending.get(sourceId);
    if (list === undefined) {
      list = [];
      this.pending.set(sourceId, list);
    }
    list.push(interval);
  }

  /** 结束构建，建立组内查询结构。 */
  finish(): void {
    if (this.trees !== null) {
      return;
    }
    this.trees = new Map();
    for (const [sourceId, list] of this.pending) {
      this.trees.set(sourceId, buildTree(list));
    }
    this.pending.clear();
  }

  /**
   * 查询某素材上与 (qLo, qHi) 界定的范围有正长度交集的所有区间，
   * 即满足 interval.lo < qHi 且 interval.hi > qLo。仅端点相碰不算命中。
   * 结果追加到 out 并返回。
   */
  query(sourceId: string, qLo: number, qHi: number, out: T[]): T[] {
    if (this.trees === null) {
      throw new Error('finish() must be called before query()');
    }
    const tree = this.trees.get(sourceId);
    if (tree !== undefined && tree !== null) {
      queryTree(tree, qLo, qHi, out);
    }
    return out;
  }
}
