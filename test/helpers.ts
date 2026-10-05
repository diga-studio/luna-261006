import { ok, equal } from "node:assert/strict";
import { Reference, RuleDef, Snapshot } from "../src/index";

export function makeRules(n: number, prefix = "r"): RuleDef[] {
  const rules: RuleDef[] = [];
  for (let i = 0; i < n; i++) {
    rules.push({ id: `${prefix}${i}`, dependsOn: [] });
  }
  return rules;
}

export function chainRules(n: number, prefix = "r"): RuleDef[] {
  const rules = makeRules(n, prefix);
  for (let i = 0; i + 1 < n; i++) {
    rules[i]!.dependsOn.push(`${prefix}${i + 1}`);
  }
  return rules;
}

export function edgeKey(e: Reference): string {
  return `${e.from} ->${e.to}`;
}

export function sortedEdgeKeys(edges: Reference[]): string[] {
  return edges.map(edgeKey).sort();
}

// Full validation of a snapshot: order is a permutation of all rule ids and
// every reference's dependency precedes its user.
export function assertValidSnapshot(snap: Snapshot, ruleIds: string[]): void {
  equal(snap.order.length, ruleIds.length, "order must list every rule");
  const pos = new Map<string, number>();
  for (let i = 0; i < snap.order.length; i++) {
    const id = snap.order[i]!;
    ok(!pos.has(id), `duplicate id in order: ${id}`);
    pos.set(id, i);
  }
  equal(pos.size, ruleIds.length);
  for (const id of ruleIds) {
    ok(pos.has(id), `missing rule in order: ${id}`);
  }
  for (const e of snap.edges) {
    const pf = pos.get(e.from);
    const pt = pos.get(e.to);
    ok(pf !== undefined && pt !== undefined, `edge endpoint missing: ${edgeKey(e)}`);
    ok(pt! < pf!, `dependency must precede user: ${edgeKey(e)}`);
  }
}

// Validate a cycle witness against the candidate final reference set:
// first === last, and every adjacent pair is a real candidate reference.
export function assertValidWitness(
  cycle: string[],
  candidateEdges: Set<string>
): void {
  ok(cycle.length >= 2, "witness needs at least two entries");
  equal(cycle[0], cycle[cycle.length - 1], "witness must start and end equal");
  for (let i = 0; i + 1 < cycle.length; i++) {
    const key = `${cycle[i]} ->${cycle[i + 1]}`;
    ok(candidateEdges.has(key), `witness edge not in candidate graph: ${key}`);
  }
}
