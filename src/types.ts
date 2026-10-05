/** A rule with its outgoing dependency references. */
export interface Rule {
  id: string;
  /** IDs of rules that must execute before this rule. */
  dependsOn: string[];
}

/** A dependency reference: `from` depends on `to` (`to` must execute first). */
export interface Ref {
  from: string;
  to: string;
}

/** One atomic batch of reference removals and additions. */
export interface Batch {
  remove: Ref[];
  add: Ref[];
}

/**
 * Access statistics for a single applyBatch call.
 * Counts actual reads/writes of rule records, reference (edge) records and
 * execution-order slots, including reordering and rollback work.
 * snapshot() work is never counted.
 */
export interface CommitStats {
  ruleReads: number;
  ruleWrites: number;
  refReads: number;
  refWrites: number;
  orderReads: number;
  orderWrites: number;
  /** Sum of all counters above. */
  total: number;
}

/** Full state of the graph: every reference plus a valid execution order. */
export interface Snapshot {
  refs: Ref[];
  /** Execution order: for every ref, `to` appears before `from`. */
  order: string[];
}

export type ApplyResult =
  | { ok: true; stats: CommitStats }
  | {
      ok: false;
      /**
       * Cycle witness: rule IDs where the first and last are equal and every
       * adjacent pair (a, b) is a reference `a depends on b` in the final
       * candidate graph of the rejected batch.
       */
      cycle: string[];
      stats: CommitStats;
    };

export interface RuleGraph {
  applyBatch(batch: Batch): ApplyResult;
  snapshot(): Snapshot;
}
