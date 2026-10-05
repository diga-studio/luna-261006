import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { createGraph, Reference } from "../src/index";
import { assertValidSnapshot, chainRules } from "./helpers";

test("100k-node chain: 20k small batches of shortcuts along dependency direction", () => {
  const n = 100_000;
  const g = createGraph(chainRules(n, "r"));
  // Shortcut targets per node are issued in increasing distance order, so
  // every added reference points along the existing dependency direction
  // (dependency already ordered before its user) and never duplicates.
  const batches = 20_000;
  const perBatch = 32;
  const nextOffset = new Array<number>(n).fill(2);
  let node = 0;
  let addedTotal = 0;
  for (let b = 0; b < batches; b++) {
    const add: Reference[] = [];
    for (let s = 0; s < perBatch; s++) {
      // find a node that still has room for one more shortcut
      let i = node;
      while (i + nextOffset[i]! >= n) {
        i = (i + 1) % (n - 3);
      }
      node = (i + 1) % (n - 3);
      const j = i + nextOffset[i]!;
      nextOffset[i]!++;
      add.push({ from: `r${i}`, to: `r${j}` });
    }
    const res = g.applyBatch({ add });
    ok(res.ok, `batch ${b} must be accepted`);
    addedTotal += add.length;
  }
  equal(addedTotal, batches * perBatch);
  const snap = g.snapshot();
  equal(snap.edges.length, n - 1 + addedTotal);
  const ids: string[] = [];
  for (let i = 0; i < n; i++) ids.push(`r${i}`);
  assertValidSnapshot(snap, ids);
});

test("32-node component beside a huge background graph: reorder commits stay local", () => {
  const background = 100_000;
  const componentSize = 32;
  const rules = chainRules(background, "b");
  for (let i = 0; i < componentSize; i++) {
    rules.push({ id: `c${i}`, dependsOn: [] });
  }
  // The component itself is a chain c0 -> c1 -> ... -> c31.
  for (let i = 0; i + 1 < componentSize; i++) {
    rules[background + i]!.dependsOn.push(`c${i + 1}`);
  }
  const g = createGraph(rules);

  // Repeatedly reverse one link of the component chain. Any orientation of a
  // path is acyclic, so every batch is legal; each one may reorder up to the
  // whole 32-node component but must never touch the background graph.
  const iterations = 2_000;
  const dir = new Array<number>(componentSize - 1).fill(1);
  let maxTotal = 0;
  for (let it = 0; it < iterations; it++) {
    const k = it % (componentSize - 1);
    const forward: Reference = { from: `c${k}`, to: `c${k + 1}` };
    const backward: Reference = { from: `c${k + 1}`, to: `c${k}` };
    const remove = [dir[k]! > 0 ? forward : backward];
    const add = [dir[k]! > 0 ? backward : forward];
    dir[k]! *= -1;
    const res = g.applyBatch({ remove, add });
    ok(res.ok, `iteration ${it} must be accepted`);
    if (res.stats.total > maxTotal) maxTotal = res.stats.total;
    ok(
      res.stats.total <= 10_000,
      `iteration ${it}: ${res.stats.total} record accesses exceeds 10000`
    );
  }
  console.log(`max record accesses per commit in 32-node component: ${maxTotal}`);
  // Full validation of the whole graph (background + component).
  const snap = g.snapshot();
  equal(snap.edges.length, background - 1 + componentSize - 1);
  const ids: string[] = [];
  for (let i = 0; i < background; i++) ids.push(`b${i}`);
  for (let i = 0; i < componentSize; i++) ids.push(`c${i}`);
  assertValidSnapshot(snap, ids);
});
