import { Bdd } from './bdd';
import type {
  AnalysisResult,
  FlowDefinition,
  FlowNode,
  MissingFieldReport,
  NodeId,
} from './types';

/**
 * Symbolically explores every execution of the flow at once.
 *
 * For each node N it maintains, as BDDs over the switch variables:
 *   reach[N]      — inputs that arrive at N without an earlier failure;
 *   present[N][f] — inputs on which field f exists when arriving at N.
 *
 * Both are exact (not approximations), so a (node, field) pair is reported
 * iff some switch input makes the execution fail there first with that
 * field missing, and each report carries a concrete witness input.
 */
export function analyzeFlow(flow: FlowDefinition): AnalysisResult {
  const byId = new Map<NodeId, FlowNode>();
  let entry: FlowNode | undefined;
  for (const node of flow.nodes) {
    byId.set(node.id, node);
    if (node.kind === 'entry') entry = node;
  }
  if (entry === undefined) {
    throw new Error('flow has no entry node');
  }

  const fieldIndex = new Map<string, number>();
  const fields: string[] = [];
  for (const node of flow.nodes) {
    if (node.kind !== 'action') continue;
    for (const name of [...node.requires, ...node.produces]) {
      if (!fieldIndex.has(name)) {
        fieldIndex.set(name, fields.length);
        fields.push(name);
      }
    }
  }
  const fieldCount = fields.length;

  const order = topoOrder(flow, byId);

  const bdd = new Bdd();
  const reach = new Map<NodeId, number>();
  const present = new Map<NodeId, number[]>();
  for (const node of flow.nodes) {
    reach.set(node.id, Bdd.FALSE);
    present.set(node.id, new Array<number>(fieldCount).fill(Bdd.FALSE));
  }
  reach.set(entry.id, Bdd.TRUE);

  const reports: MissingFieldReport[] = [];

  const contribute = (
    target: NodeId,
    reachContribution: number,
    presentContribution: readonly number[],
  ): void => {
    reach.set(target, bdd.or(reach.get(target)!, reachContribution));
    const targetPresent = present.get(target)!;
    for (let f = 0; f < fieldCount; f++) {
      const incoming = presentContribution[f]!;
      if (incoming !== Bdd.FALSE) {
        targetPresent[f] = bdd.or(targetPresent[f]!, incoming);
      }
    }
  };

  for (const id of order) {
    const node = byId.get(id)!;
    const r = reach.get(id)!;
    if (node.kind !== 'end' && r === Bdd.FALSE) continue;
    const p = present.get(id)!;

    switch (node.kind) {
      case 'entry':
        contribute(node.next, r, p);
        break;
      case 'condition': {
        const onSwitch = bdd.variable(node.switchIndex);
        const offSwitch = bdd.not(onSwitch);
        contribute(node.onTrue, bdd.and(r, onSwitch), andAll(bdd, p, onSwitch));
        contribute(node.onFalse, bdd.and(r, offSwitch), andAll(bdd, p, offSwitch));
        break;
      }
      case 'action': {
        let success = r;
        for (const name of node.requires) {
          const f = fieldIndex.get(name)!;
          const missingHere = bdd.and(r, bdd.not(p[f]!));
          if (missingHere !== Bdd.FALSE) {
            reports.push({
              nodeId: id,
              field: name,
              witness: bdd.oneSat(missingHere, flow.switchCount)!,
            });
          }
          success = bdd.and(success, p[f]!);
        }
        const produced = p.slice();
        for (const name of node.produces) {
          produced[fieldIndex.get(name)!] = Bdd.TRUE;
        }
        contribute(node.next, success, andAll(bdd, produced, success));
        break;
      }
      case 'end':
        break;
    }
  }

  reports.sort((a, b) =>
    a.nodeId === b.nodeId ? (a.field < b.field ? -1 : 1) : a.nodeId < b.nodeId ? -1 : 1,
  );
  return { safe: reports.length === 0, reports };
}

function andAll(bdd: Bdd, formulas: readonly number[], gate: number): number[] {
  return formulas.map((f) => (f === Bdd.FALSE ? f : bdd.and(f, gate)));
}

/** Kahn topological order; entry first. Unreached-cycle safety net included. */
function topoOrder(flow: FlowDefinition, byId: Map<NodeId, FlowNode>): NodeId[] {
  const indegree = new Map<NodeId, number>();
  for (const node of flow.nodes) indegree.set(node.id, 0);
  const successorsOf = (node: FlowNode): NodeId[] => {
    switch (node.kind) {
      case 'entry':
      case 'action':
        return [node.next];
      case 'condition':
        return [node.onTrue, node.onFalse];
      case 'end':
        return [];
    }
  };
  for (const node of flow.nodes) {
    for (const next of successorsOf(node)) {
      indegree.set(next, indegree.get(next)! + 1);
    }
  }
  const queue: NodeId[] = [];
  for (const node of flow.nodes) {
    if (indegree.get(node.id) === 0) queue.push(node.id);
  }
  const order: NodeId[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of successorsOf(byId.get(id)!)) {
      const remaining = indegree.get(next)! - 1;
      indegree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }
  if (order.length !== flow.nodes.length) {
    throw new Error('flow is not acyclic');
  }
  return order;
}
