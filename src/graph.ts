import {
  ApplyResult,
  Batch,
  CommitStats,
  RuleDef,
  RuleGraph,
  RuleId,
  Snapshot,
} from "./types";

interface ReorderLog {
  lb: number;
  ub: number;
  segment: number[];
}

class Stats implements CommitStats {
  ruleReads = 0;
  ruleWrites = 0;
  edgeReads = 0;
  edgeWrites = 0;
  orderReads = 0;
  orderWrites = 0;
  get total(): number {
    return (
      this.ruleReads +
      this.ruleWrites +
      this.edgeReads +
      this.edgeWrites +
      this.orderReads +
      this.orderWrites
    );
  }
}

class RuleGraphImpl implements RuleGraph {
  private readonly ids: RuleId[];
  private readonly indexOf: Map<RuleId, number>;
  // deps[u]: nodes that u depends on (reference out-edges, from=u).
  private readonly deps: Array<Set<number>>;
  // users[v]: nodes that depend on v (reference in-edges, to=v).
  private readonly users: Array<Set<number>>;
  // order[pos] = node index; a valid topological order (dependency first).
  private readonly order: number[];
  // pos[node] = position in order.
  private readonly pos: number[];

  private st: Stats | null = null;

  constructor(rules: RuleDef[]) {
    const n = rules.length;
    this.ids = new Array<RuleId>(n);
    this.indexOf = new Map<RuleId, number>();
    for (let i = 0; i < n; i++) {
      const id = rules[i]!.id;
      if (this.indexOf.has(id)) {
        throw new Error(`duplicate rule id: ${id}`);
      }
      this.indexOf.set(id, i);
      this.ids[i] = id;
    }
    this.deps = new Array<Set<number>>(n);
    this.users = new Array<Set<number>>(n);
    for (let i = 0; i < n; i++) {
      this.deps[i] = new Set<number>();
      this.users[i] = new Set<number>();
    }
    for (let i = 0; i < n; i++) {
      for (const depId of rules[i]!.dependsOn) {
        const j = this.indexOf.get(depId);
        if (j === undefined) {
          throw new Error(`rule ${rules[i]!.id} depends on unknown rule ${depId}`);
        }
        if (j === i) {
          throw new Error(`rule ${rules[i]!.id} self-dependency`);
        }
        if (!this.deps[i]!.has(j)) {
          this.deps[i]!.add(j);
          this.users[j]!.add(i);
        }
      }
    }
    // Kahn's topological sort: a rule is emitted once all its dependencies
    // have been emitted, so every dependency precedes its users.
    const indeg = new Array<number>(n);
    const queue: number[] = [];
    for (let i = 0; i < n; i++) {
      indeg[i] = this.deps[i]!.size;
      if (indeg[i] === 0) queue.push(i);
    }
    this.order = new Array<number>(n);
    this.pos = new Array<number>(n);
    let emitted = 0;
    for (let head = 0; head < queue.length; head++) {
      const v = queue[head]!;
      this.pos[v] = emitted;
      this.order[emitted] = v;
      emitted++;
      for (const w of this.users[v]!) {
        indeg[w]!--;
        if (indeg[w] === 0) queue.push(w);
      }
    }
    if (emitted !== n) {
      throw new Error("initial graph contains a cycle");
    }
  }

  private ruleRead(k = 1): void {
    if (this.st) this.st.ruleReads += k;
  }
  private edgeRead(k = 1): void {
    if (this.st) this.st.edgeReads += k;
  }
  private edgeWrite(k = 1): void {
    if (this.st) this.st.edgeWrites += k;
  }
  private orderRead(k = 1): void {
    if (this.st) this.st.orderReads += k;
  }
  private orderWrite(k = 1): void {
    if (this.st) this.st.orderWrites += k;
  }

  applyBatch(batch: Batch): ApplyResult {
    this.st = new Stats();
    try {
      const removed: Array<[number, number]> = [];
      const added: Array<[number, number]> = [];
      const reorderLog: ReorderLog[] = [];

      for (const ref of batch.remove ?? []) {
        const f = this.mustIndex(ref.from);
        const t = this.mustIndex(ref.to);
        this.removeEdge(f, t);
        removed.push([f, t]);
      }

      for (const ref of batch.add ?? []) {
        const f = this.mustIndex(ref.from);
        const t = this.mustIndex(ref.to);
        const witness = this.insertEdge(f, t, added, reorderLog);
        if (witness !== null) {
          this.rollback(removed, added, reorderLog);
          const cycle = witness.map((i) => this.ids[i]!);
          return { ok: false, cycle, stats: this.st };
        }
      }

      return { ok: true, stats: this.st };
    } finally {
      this.st = null;
    }
  }

  snapshot(): Snapshot {
    const edges: Snapshot["edges"] = [];
    for (let u = 0; u < this.ids.length; u++) {
      const from = this.ids[u]!;
      for (const v of this.deps[u]!) {
        edges.push({ from, to: this.ids[v]! });
      }
    }
    const order = this.order.map((i) => this.ids[i]!);
    return { edges, order };
  }

  private mustIndex(id: RuleId): number {
    this.ruleRead();
    const idx = this.indexOf.get(id);
    if (idx === undefined) {
      throw new Error(`unknown rule id: ${id}`);
    }
    return idx;
  }

  private removeEdge(f: number, t: number): void {
    this.ruleRead(2);
    this.deps[f]!.delete(t);
    this.users[t]!.delete(f);
    this.edgeWrite(2);
  }

  private addEdge(f: number, t: number): void {
    this.ruleRead(2);
    this.deps[f]!.add(t);
    this.users[t]!.add(f);
    this.edgeWrite(2);
  }

  /**
   * Insert reference f -> t (f depends on t), maintaining a valid order.
   * Returns null on success, or a node-index cycle witness (first == last,
   * adjacent pairs are references in the candidate final graph).
   */
  private insertEdge(
    f: number,
    t: number,
    added: Array<[number, number]>,
    reorderLog: ReorderLog[]
  ): number[] | null {
    this.orderRead(2);
    const posF = this.pos[f]!;
    const posT = this.pos[t]!;
    if (posT < posF) {
      // Already consistent with the current order: cannot create a cycle.
      this.addEdge(f, t);
      added.push([f, t]);
      return null;
    }

    // The edge violates the current order. A cycle exists iff t already
    // reaches f through dependency edges (t depends on ... depends on f).
    // All nodes on such a path lie in the position range [posF, posT].
    const reachF = new Set<number>(); // nodes that can reach f (backward from f)
    const parent = new Map<number, number>();
    const stack: number[] = [f];
    reachF.add(f);
    parent.set(f, -1);
    let cycle = false;
    while (stack.length > 0) {
      const c = stack.pop()!;
      this.ruleRead();
      if (c === t) {
        cycle = true;
        break;
      }
      const preds = this.users[c]!;
      this.edgeRead(preds.size);
      for (const p of preds) {
        this.orderRead();
        if (this.pos[p]! <= posT && !reachF.has(p)) {
          reachF.add(p);
          parent.set(p, c);
          stack.push(p);
        }
      }
    }

    if (cycle) {
      // Reconstruct reference path t ~~> f, then close the loop with f -> t.
      const path: number[] = [];
      for (let cur = t; cur !== -1; cur = parent.get(cur)!) {
        path.push(cur);
      }
      path.push(t);
      return path;
    }

    // Forward closure from t within the region: nodes reachable from t.
    const reachB = new Set<number>();
    reachB.add(t);
    stack.push(t);
    while (stack.length > 0) {
      const c = stack.pop()!;
      this.ruleRead();
      const succs = this.deps[c]!;
      this.edgeRead(succs.size);
      for (const w of succs) {
        this.orderRead();
        if (this.pos[w]! >= posF && !reachB.has(w)) {
          reachB.add(w);
          stack.push(w);
        }
      }
    }

    this.addEdge(f, t);
    added.push([f, t]);

    // Pearce-Kelly style reordering of the affected region [posF, posT]:
    // nodes that must move after (reachB), then untouched middle, then
    // nodes that must move before (reachF); relative order preserved.
    const len = posT - posF + 1;
    const region = new Array<number>(len);
    this.orderRead(len);
    for (let i = 0; i < len; i++) {
      region[i] = this.order[posF + i]!;
    }
    this.orderWrite(len);
    reorderLog.push({ lb: posF, ub: posT, segment: region.slice() });

    const seqB: number[] = [];
    const seqM: number[] = [];
    const seqF: number[] = [];
    for (const w of region) {
      if (reachB.has(w)) seqB.push(w);
      else if (reachF.has(w)) seqF.push(w);
      else seqM.push(w);
    }
    const newSeg = seqB.concat(seqM, seqF);
    this.orderWrite(2 * len);
    for (let i = 0; i < len; i++) {
      const w = newSeg[i]!;
      this.order[posF + i] = w;
      this.pos[w] = posF + i;
    }
    return null;
  }

  private rollback(
    removed: Array<[number, number]>,
    added: Array<[number, number]>,
    reorderLog: ReorderLog[]
  ): void {
    for (let i = reorderLog.length - 1; i >= 0; i--) {
      const log = reorderLog[i]!;
      const len = log.ub - log.lb + 1;
      this.orderWrite(2 * len);
      for (let j = 0; j < len; j++) {
        const w = log.segment[j]!;
        this.order[log.lb + j] = w;
        this.pos[w] = log.lb + j;
      }
    }
    for (let i = added.length - 1; i >= 0; i--) {
      const [f, t] = added[i]!;
      this.removeEdge(f, t);
    }
    for (const [f, t] of removed) {
      this.addEdge(f, t);
    }
  }
}

export function createGraph(rules: RuleDef[]): RuleGraph {
  return new RuleGraphImpl(rules);
}
