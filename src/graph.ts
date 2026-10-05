import type {
  ApplyResult,
  Batch,
  CommitStats,
  Ref,
  Rule,
  RuleGraph,
  Snapshot,
} from './types.ts';

function emptyStats(): CommitStats {
  return {
    ruleReads: 0,
    ruleWrites: 0,
    refReads: 0,
    refWrites: 0,
    orderReads: 0,
    orderWrites: 0,
    total: 0,
  };
}

type Undo =
  | { kind: 'add-edge'; from: string; to: string }
  | { kind: 'remove-edge'; from: string; to: string }
  | { kind: 'order-slot'; index: number; prevId: string };

class IncrementalGraph implements RuleGraph {
  /** Execution-direction successors: succ of `a` are rules that depend on `a`. */
  private readonly succ = new Map<string, Set<string>>();
  /** Execution-direction predecessors: pred of `a` are rules `a` depends on. */
  private readonly pred = new Map<string, Set<string>>();
  /** Current execution order (topological). */
  private order: string[] = [];
  /** Position of each rule id in `order`. */
  private readonly pos = new Map<string, number>();
  /** Access statistics of the applyBatch call currently running. */
  private stats: CommitStats = emptyStats();

  constructor(rules: Rule[]) {
    for (const rule of rules) {
      if (this.succ.has(rule.id)) {
        throw new Error(`duplicate rule id: ${rule.id}`);
      }
      this.succ.set(rule.id, new Set());
      this.pred.set(rule.id, new Set());
    }
    for (const rule of rules) {
      const preds = this.pred.get(rule.id)!;
      for (const dep of rule.dependsOn) {
        const succOfDep = this.succ.get(dep);
        if (succOfDep === undefined) {
          throw new Error(`unknown rule id in dependsOn: ${dep}`);
        }
        if (!succOfDep.has(rule.id)) {
          succOfDep.add(rule.id);
          preds.add(dep);
        }
      }
    }
    this.order = this.topoSort();
    for (let i = 0; i < this.order.length; i++) {
      this.pos.set(this.order[i]!, i);
    }
  }

  /** Kahn's algorithm over the full graph; used only at construction. */
  private topoSort(): string[] {
    const indegree = new Map<string, number>();
    const queue: string[] = [];
    for (const [id, preds] of this.pred) {
      indegree.set(id, preds.size);
      if (preds.size === 0) queue.push(id);
    }
    const order: string[] = [];
    for (let head = 0; head < queue.length; head++) {
      const id = queue[head]!;
      order.push(id);
      for (const next of this.succ.get(id)!) {
        const d = indegree.get(next)! - 1;
        indegree.set(next, d);
        if (d === 0) queue.push(next);
      }
    }
    if (order.length !== this.pred.size) {
      throw new Error('initial graph contains a cycle');
    }
    return order;
  }

  snapshot(): Snapshot {
    const refs: Ref[] = [];
    for (const [to, froms] of this.succ) {
      for (const from of froms) {
        refs.push({ from, to });
      }
    }
    return { refs, order: [...this.order] };
  }

  applyBatch(batch: Batch): ApplyResult {
    this.stats = emptyStats();
    const undo: Undo[] = [];
    let rejected: string[] | null = null;
    for (const ref of batch.remove) {
      this.removeEdge(ref.from, ref.to, undo);
    }
    for (const ref of batch.add) {
      const cycle = this.insertEdge(ref.from, ref.to, undo);
      if (cycle !== null) {
        rejected = cycle;
        break;
      }
    }
    if (rejected !== null) {
      this.rollback(undo);
      return { ok: false, cycle: rejected, stats: this.finalizeStats() };
    }
    return { ok: true, stats: this.finalizeStats() };
  }

  private finalizeStats(): CommitStats {
    const s = this.stats;
    s.total =
      s.ruleReads +
      s.ruleWrites +
      s.refReads +
      s.refWrites +
      s.orderReads +
      s.orderWrites;
    return s;
  }

  private readPos(id: string): number {
    this.stats.orderReads++;
    return this.pos.get(id)!;
  }

  private setSlot(index: number, id: string, undo: Undo[]): void {
    this.stats.orderReads++;
    const prevId = this.order[index]!;
    if (prevId === id) return;
    undo.push({ kind: 'order-slot', index, prevId });
    this.order[index] = id;
    this.pos.set(id, index);
    this.stats.orderWrites += 2;
  }

  private addEdgeRaw(from: string, to: string): void {
    this.stats.ruleReads += 2;
    this.succ.get(to)!.add(from);
    this.pred.get(from)!.add(to);
    this.stats.refWrites += 2;
  }

  private removeEdgeRaw(from: string, to: string): void {
    this.stats.ruleReads += 2;
    this.succ.get(to)!.delete(from);
    this.pred.get(from)!.delete(to);
    this.stats.refWrites += 2;
  }

  private addEdge(from: string, to: string, undo: Undo[]): void {
    this.addEdgeRaw(from, to);
    undo.push({ kind: 'add-edge', from, to });
  }

  private removeEdge(from: string, to: string, undo: Undo[]): void {
    this.removeEdgeRaw(from, to);
    undo.push({ kind: 'remove-edge', from, to });
  }

  /**
   * Insert dependency `from -> to` (from depends on to), keeping the execution
   * order valid. Returns a dependency-direction cycle witness if the edge
   * would close a cycle; in that case the edge is NOT added and the caller
   * rolls back. Otherwise the edge is added and null is returned.
   */
  private insertEdge(from: string, to: string, undo: Undo[]): string[] | null {
    // Execution-direction edge: x must execute before y.
    const x = to;
    const y = from;
    const posX = this.readPos(x);
    const posY = this.readPos(y);
    if (x === y) {
      return [y, y];
    }
    if (posX < posY) {
      this.addEdge(from, to, undo);
      return null;
    }
    // Invalidating edge (Pearce-Kelly dynamic topological sort):
    // deltaF = nodes reachable from y with pos <= posX (forward),
    // deltaB = nodes reaching x with pos >= posY (backward).
    const parent = new Map<string, string>();
    const deltaF: string[] = [];
    const visitedF = new Set<string>([y]);
    const stackF = [y];
    while (stackF.length > 0) {
      const v = stackF.pop()!;
      deltaF.push(v);
      this.stats.ruleReads++;
      for (const w of this.succ.get(v)!) {
        this.stats.refReads++;
        if (visitedF.has(w)) continue;
        if (this.readPos(w) > posX) continue;
        parent.set(w, v);
        if (w === x) {
          return this.buildWitness(y, x, parent);
        }
        visitedF.add(w);
        stackF.push(w);
      }
    }
    const deltaB: string[] = [];
    const visitedB = new Set<string>([x]);
    const stackB = [x];
    while (stackB.length > 0) {
      const v = stackB.pop()!;
      deltaB.push(v);
      this.stats.ruleReads++;
      for (const w of this.pred.get(v)!) {
        this.stats.refReads++;
        if (visitedB.has(w)) continue;
        if (this.readPos(w) < posY) continue;
        visitedB.add(w);
        stackB.push(w);
      }
    }
    // Reorder: all of deltaB (sorted by old pos) before all of deltaF,
    // packed into the combined sorted slots they already occupy.
    const entriesF = deltaF.map((id) => ({ id, p: this.readPos(id) }));
    const entriesB = deltaB.map((id) => ({ id, p: this.readPos(id) }));
    entriesF.sort((a, b) => a.p - b.p);
    entriesB.sort((a, b) => a.p - b.p);
    const slots = entriesB.concat(entriesF).map((e) => e.p);
    slots.sort((a, b) => a - b);
    let i = 0;
    for (const e of entriesB) {
      this.setSlot(slots[i++]!, e.id, undo);
    }
    for (const e of entriesF) {
      this.setSlot(slots[i++]!, e.id, undo);
    }
    this.addEdge(from, to, undo);
    return null;
  }

  /**
   * Reconstruct a dependency-direction cycle witness from the forward DFS
   * parent map after reaching x from y (execution direction).
   * Execution path y = p0 -> p1 -> ... -> pk = x becomes the dependency
   * cycle [y, x, p(k-1), ..., p1, y]: the first hop (y, x) is the new
   * reference "y depends on x"; every later hop (p(i+1), p(i)) is the
   * reference "p(i+1) depends on p(i)" given by the execution edge
   * p(i) -> p(i+1). Every adjacent pair is a reference present in the
   * final candidate graph.
   */
  private buildWitness(
    y: string,
    x: string,
    parent: Map<string, string>,
  ): string[] {
    const chain = [x];
    let cur = x;
    while (cur !== y) {
      cur = parent.get(cur)!;
      chain.push(cur);
    }
    // chain = [x = pk, p(k-1), ..., p1, y = p0]
    const witness = [y, x];
    for (let i = 1; i < chain.length - 1; i++) {
      witness.push(chain[i]!);
    }
    witness.push(y);
    return witness;
  }

  private rollback(undo: Undo[]): void {
    for (let i = undo.length - 1; i >= 0; i--) {
      const u = undo[i]!;
      if (u.kind === 'add-edge') {
        this.removeEdgeRaw(u.from, u.to);
      } else if (u.kind === 'remove-edge') {
        this.addEdgeRaw(u.from, u.to);
      } else {
        this.order[u.index] = u.prevId;
        this.pos.set(u.prevId, u.index);
        this.stats.orderWrites += 2;
      }
    }
  }
}

/** Create a graph instance from a complete initial acyclic graph. */
export function createGraph(rules: Rule[]): RuleGraph {
  return new IncrementalGraph(rules);
}
