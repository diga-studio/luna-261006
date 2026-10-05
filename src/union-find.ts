/** 基于数组的并查集，用于在一组候选记录键上重算连通分量。 */
export class UnionFind {
  private readonly parent: number[] = [];
  private readonly rank: number[] = [];
  private readonly index = new Map<string, number>();
  readonly keys: string[] = [];

  /** 注册一个键并返回其内部编号（已注册则返回原编号）。 */
  add(key: string): number {
    let i = this.index.get(key);
    if (i === undefined) {
      i = this.keys.length;
      this.index.set(key, i);
      this.keys.push(key);
      this.parent.push(i);
      this.rank.push(0);
    }
    return i;
  }

  find(i: number): number {
    let root = i;
    while (this.parent[root] !== root) root = this.parent[root];
    while (this.parent[i] !== root) {
      const next = this.parent[i];
      this.parent[i] = root;
      i = next;
    }
    return root;
  }

  union(a: number, b: number): void {
    let ra = this.find(a);
    let rb = this.find(b);
    if (ra === rb) return;
    if (this.rank[ra] < this.rank[rb]) {
      const t = ra;
      ra = rb;
      rb = t;
    }
    this.parent[rb] = ra;
    if (this.rank[ra] === this.rank[rb]) this.rank[ra]++;
  }

  /** 按根编号分组，返回每组内部编号的数组。 */
  components(): number[][] {
    const groups = new Map<number, number[]>();
    for (let i = 0; i < this.keys.length; i++) {
      const root = this.find(i);
      const g = groups.get(root);
      if (g) g.push(i);
      else groups.set(root, [i]);
    }
    return [...groups.values()];
  }
}
