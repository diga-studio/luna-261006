import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import { createGraph, Reference, RuleDef, Snapshot } from "../src/index";
import {
  assertValidSnapshot,
  assertValidWitness,
  edgeKey,
  sortedEdgeKeys,
} from "./helpers";

function candidateEdgeSet(
  before: Snapshot,
  remove: Reference[],
  add: Reference[]
): Set<string> {
  const set = new Set(before.edges.map(edgeKey));
  for (const r of remove) set.delete(edgeKey(r));
  for (const a of add) set.add(edgeKey(a));
  return set;
}

test("individually legal adds that jointly form a cycle are rejected with a witness", () => {
  // Empty graph: a->b and b->a are each legal alone, cyclic together.
  const rules: RuleDef[] = [
    { id: "a", dependsOn: [] },
    { id: "b", dependsOn: [] },
    { id: "c", dependsOn: [] },
  ];
  const g = createGraph(rules);
  const before = g.snapshot();
  const remove: Reference[] = [];
  const add: Reference[] = [
    { from: "a", to: "b" },
    { from: "b", to: "c" },
    { from: "c", to: "a" },
  ];
  const res = g.applyBatch({ add });
  ok(!res.ok, "joint cycle must be rejected");
  assertValidWitness(res.cycle, candidateEdgeSet(before, remove, add));
  // Rejection must leave graph and order exactly as before.
  const after = g.snapshot();
  deepEqual(after.order, before.order, "order must be restored exactly");
  deepEqual(sortedEdgeKeys(after.edges), sortedEdgeKeys(before.edges));
  equal(after.edges.length, 0);
});

test("witness uses only edges of the candidate final graph (no removed edges)", () => {
  // Original+adds contains a "cycle" b->c->b that relies on the removed edge
  // b->c; the real cycle in the final graph is x->y->x. The witness must use
  // only candidate-final edges.
  const rules: RuleDef[] = [
    { id: "a", dependsOn: ["b"] },
    { id: "b", dependsOn: ["c"] },
    { id: "c", dependsOn: [] },
    { id: "x", dependsOn: ["y"] },
    { id: "y", dependsOn: [] },
  ];
  const g = createGraph(rules);
  const before = g.snapshot();
  const remove: Reference[] = [{ from: "b", to: "c" }];
  const add: Reference[] = [
    { from: "c", to: "b" },
    { from: "y", to: "x" },
  ];
  const res = g.applyBatch({ remove, add });
  ok(!res.ok);
  const candidate = candidateEdgeSet(before, remove, add);
  assertValidWitness(res.cycle, candidate);
  // The removed edge must not appear in the witness.
  for (let i = 0; i + 1 < res.cycle.length; i++) {
    ok(
      !(res.cycle[i] === "b" && res.cycle[i + 1] === "c"),
      "witness must not use the removed edge"
    );
  }
  const after = g.snapshot();
  deepEqual(after.order, before.order);
  deepEqual(sortedEdgeKeys(after.edges), sortedEdgeKeys(before.edges));
});

test("graph stays usable after rejection: legal reordering commit succeeds", () => {
  const rules: RuleDef[] = [
    { id: "p", dependsOn: [] },
    { id: "q", dependsOn: [] },
    { id: "r", dependsOn: [] },
  ];
  const g = createGraph(rules);
  const bad = g.applyBatch({
    add: [
      { from: "p", to: "q" },
      { from: "q", to: "p" },
    ],
  });
  ok(!bad.ok);
  // A legal commit that requires reordering (r before p) must still work.
  const good = g.applyBatch({ add: [{ from: "p", to: "r" }] });
  ok(good.ok, "legal reordering commit after rejection must be accepted");
  const snap = g.snapshot();
  const pos = new Map(snap.order.map((id, i) => [id, i]));
  ok(pos.get("r")! < pos.get("p")!);
  assertValidSnapshot(snap, ["p", "q", "r"]);
  deepEqual(sortedEdgeKeys(snap.edges), ["p ->r"]);
});

test("cycle spanning edges added earlier in the same batch is detected", () => {
  // Three adds, each acyclic against the original graph, jointly cyclic.
  const rules: RuleDef[] = [
    { id: "a", dependsOn: [] },
    { id: "b", dependsOn: [] },
    { id: "c", dependsOn: [] },
    { id: "d", dependsOn: [] },
  ];
  const g = createGraph(rules);
  const before = g.snapshot();
  const add: Reference[] = [
    { from: "a", to: "b" },
    { from: "b", to: "c" },
    { from: "c", to: "a" },
    { from: "d", to: "a" },
  ];
  const res = g.applyBatch({ add });
  ok(!res.ok);
  assertValidWitness(res.cycle, candidateEdgeSet(before, [], add));
  deepEqual(g.snapshot().order, before.order);
  equal(g.snapshot().edges.length, 0);
});
