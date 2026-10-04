import test from "node:test";
import assert from "node:assert/strict";
import { exportOutline } from "../dist/index.js";
import { bruteForceOptimum } from "./helpers.js";

// Locally nearest parents form three interacting cycles:
//   A = {1,2,3}, B = {3,4,5}, C = {4,5,6}
// Breaking one cycle changes which breaks are legal in the others, so a
// greedy local choice cannot find the global optimum.
const interactingCycles = {
  nodes: [
    { id: 1, title: "Alpha", x: 0, y: 0 },
    { id: 2, title: "Beta", x: 4, y: 0 },
    { id: 3, title: "Gamma", x: 2, y: 1 },
    { id: 4, title: "Delta", x: 8, y: 0 },
    { id: 5, title: "Epsilon", x: 9, y: 1 },
    { id: 6, title: "Zeta", x: 6, y: 1 },
  ],
  edges: [
    { from: 1, to: 2 },
    { from: 2, to: 3 },
    { from: 3, to: 1 },
    { from: 3, to: 4 },
    { from: 4, to: 5 },
    { from: 5, to: 3 },
    { from: 4, to: 6 },
    { from: 6, to: 4 },
    { from: 5, to: 6 },
    { from: 2, to: 4 },
  ],
};

// A second graph: two cycles sharing an edge, plus a long cheap-looking
// cross edge that the optimum must reject.
const sharedEdgeCycles = {
  nodes: [
    { id: 1, title: "N1", x: 0, y: 0 },
    { id: 2, title: "N2", x: 3, y: 0 },
    { id: 3, title: "N3", x: 3, y: 3 },
    { id: 4, title: "N4", x: 0, y: 3 },
    { id: 5, title: "N5", x: 10, y: 10 },
  ],
  edges: [
    { from: 1, to: 2 },
    { from: 2, to: 3 },
    { from: 3, to: 1 },
    { from: 3, to: 4 },
    { from: 4, to: 1 },
    { from: 4, to: 5 },
    { from: 5, to: 2 },
  ],
};

for (const [name, graph] of Object.entries({ interactingCycles, sharedEdgeCycles })) {
  test(`${name}: matches independently computed global optimum`, () => {
    const result = exportOutline(graph);
    const { best, nodes } = bruteForceOptimum(graph);
    assert.ok(best, "brute force found a feasible solution");

    const topLevel = result.roots.length;
    assert.equal(topLevel, best.roots, "top-level entry count");
    assert.equal(result.totalCost, best.cost, "total spatial cost");

    const sequence = nodes.map((n) => result.parents.get(n.id));
    assert.deepEqual(sequence, best.parent, "parent sequence");
  });
}

test("result is a legal hierarchy: every node once, parent edges exist, acyclic", () => {
  const graph = interactingCycles;
  const result = exportOutline(graph);
  const edgeSet = new Set(graph.edges.map((e) => `${e.from}->${e.to}`));

  const seen = new Set();
  const visit = (entry, ancestors) => {
    assert.ok(!seen.has(entry.nodeId), `node ${entry.nodeId} expanded twice`);
    seen.add(entry.nodeId);
    assert.ok(!ancestors.has(entry.nodeId), `cycle at node ${entry.nodeId}`);
    if (entry.parentId !== 0) {
      assert.ok(
        edgeSet.has(`${entry.parentId}->${entry.nodeId}`),
        `parent link ${entry.parentId}->${entry.nodeId} must be an original edge`,
      );
    }
    const next = new Set(ancestors).add(entry.nodeId);
    for (const child of entry.children) {
      assert.equal(child.parentId, entry.nodeId);
      visit(child, next);
    }
  };
  for (const root of result.roots) {
    assert.equal(root.parentId, 0);
    visit(root, new Set());
  }
  assert.equal(seen.size, graph.nodes.length, "every node appears exactly once");
});
