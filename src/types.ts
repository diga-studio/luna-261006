export type RuleId = string;

export interface RuleDef {
  id: RuleId;
  dependsOn: RuleId[];
}

export interface Reference {
  from: RuleId;
  to: RuleId;
}

export interface Batch {
  remove?: Reference[];
  add?: Reference[];
}

export interface CommitStats {
  ruleReads: number;
  ruleWrites: number;
  edgeReads: number;
  edgeWrites: number;
  orderReads: number;
  orderWrites: number;
  total: number;
}

export interface Snapshot {
  edges: Reference[];
  order: RuleId[];
}

export type ApplyResult =
  | { ok: true; stats: CommitStats }
  | { ok: false; cycle: RuleId[]; stats: CommitStats };

export interface RuleGraph {
  applyBatch(batch: Batch): ApplyResult;
  snapshot(): Snapshot;
}
