import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import { createGraph, RuleDef } from "../src/index";
import { assertValidSnapshot, sortedEdgeKeys } from "./helpers";

function ids(rules: RuleDef[]): string[] {
  return rules.map((r) => r.id);
}

test("same-batch remove + reverse add is accepted despite temporary cycle if misordered", () => {
  // A depends on B. Atomically reverse the reference: B depends on A.
  // Adding B->A before removing A->B would form a temporary cycle, but the
  // final graph is acyclic and must be accepted.
  const rules: RuleDef[] = [
    { id: "A", dependsOn: ["B"] },
    { id: "B", dependsOn: [] },
  ];
  const g = createGraph(rules);
  const res = g.applyBatch({
    remove: [{ from: "A", to: "B" }],
    add: [{ from: "B", to: "A" }],
  });
  ok(res.ok, "final acyclic batch must be accepted");
  const snap = g.snapshot();
  deepEqual(sortedEdgeKeys(snap.edges), ["B ->A"]);
  assertValidSnapshot(snap, ids(rules));
  const pos = new Map(snap.order.map((id, i) => [id, i]));
  ok(pos.get("A")! < pos.get("B")!, "A must execute before B now");
});

test("reversal inside a longer chain in one batch", () => {
  // r0 -> r1 -> r2 -> r3 (ri depends on r(i+1)); reverse the middle link.
  const rules: RuleDef[] = [
    { id: "r0", dependsOn: ["r1"] },
    { id: "r1", dependsOn: ["r2"] },
    { id: "r2", dependsOn: ["r3"] },
    { id: "r3", dependsOn: [] },
  ];
  const g = createGraph(rules);
  const res = g.applyBatch({
    remove: [{ from: "r1", to: "r2" }],
    add: [{ from: "r2", to: "r1" }],
  });
  ok(res.ok);
  const snap = g.snapshot();
  deepEqual(sortedEdgeKeys(snap.edges), ["r0 ->r1", "r2 ->r1", "r2 ->r3"]);
  assertValidSnapshot(snap, ids(rules));
});

test("legal commit may change the execution order (no fixed-order rejection)", () => {
  // Independent rules keep creation order; adding x depends-on y forces
  // y before x, which requires reordering.
  const rules: RuleDef[] = [
    { id: "x", dependsOn: [] },
    { id: "y", dependsOn: [] },
    { id: "z", dependsOn: [] },
  ];
  const g = createGraph(rules);
  deepEqual(g.snapshot().order, ["x", "y", "z"]);
  const res = g.applyBatch({ add: [{ from: "x", to: "z" }] });
  ok(res.ok, "reordering commit must be accepted");
  const snap = g.snapshot();
  const pos = new Map(snap.order.map((id, i) => [id, i]));
  ok(pos.get("z")! < pos.get("x")!, "z must be ordered before x");
  assertValidSnapshot(snap, ids(rules));
});

test("stats are returned per commit and total is the sum of parts", () => {
  const g = createGraph([
    { id: "a", dependsOn: [] },
    { id: "b", dependsOn: [] },
  ]);
  const res = g.applyBatch({ add: [{ from: "a", to: "b" }] });
  ok(res.ok);
  const s = res.stats;
  equal(
    s.total,
    s.ruleReads + s.ruleWrites + s.edgeReads + s.edgeWrites + s.orderReads + s.orderWrites
  );
  ok(s.total > 0);
});
