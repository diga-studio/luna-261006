/** Hard limits guaranteed by the upstream structural validation. */
export const MAX_NODES = 200;
export const MAX_SWITCHES = 40;
export const MAX_FIELDS = 40;

export type NodeId = string;

/** Entry node: exactly one per flow, exactly one outgoing edge. */
export interface EntryNode {
  id: NodeId;
  kind: 'entry';
  next: NodeId;
}

/** Condition node: tests one boolean switch, has true/false outgoing edges. */
export interface ConditionNode {
  id: NodeId;
  kind: 'condition';
  switchIndex: number;
  onTrue: NodeId;
  onFalse: NodeId;
}

/** Action node: requires fields to exist, produces fields on success. */
export interface ActionNode {
  id: NodeId;
  kind: 'action';
  requires: string[];
  produces: string[];
  next: NodeId;
}

/** End node: no outgoing edges. */
export interface EndNode {
  id: NodeId;
  kind: 'end';
}

export type FlowNode = EntryNode | ConditionNode | ActionNode | EndNode;

/**
 * A workflow definition. Assumed to have passed structural validation:
 * a DAG with a single entry, and out-degree 1/2/1/0 per node kind.
 */
export interface FlowDefinition {
  /** Number of boolean switches; all values are provided before execution. */
  switchCount: number;
  nodes: FlowNode[];
}

/** One publish-time finding: a reachable first-failure (node, field) pair. */
export interface MissingFieldReport {
  nodeId: NodeId;
  field: string;
  /** Complete switch assignment that provably triggers this first failure. */
  witness: boolean[];
}

export interface AnalysisResult {
  /** True when no switch input can fail on a missing field. */
  safe: boolean;
  /** All reachable first-failure (node, field) combinations, de-duplicated. */
  reports: MissingFieldReport[];
}

export interface ReplaySuccess {
  ok: true;
  /** Nodes visited, in execution order (includes entry and end). */
  path: NodeId[];
}

export interface ReplayFailure {
  ok: false;
  /** Nodes visited up to and including the failing action. */
  path: NodeId[];
  failedNode: NodeId;
  /** All fields required by the failing action that were absent. */
  missingFields: string[];
}

export type ReplayResult = ReplaySuccess | ReplayFailure;
