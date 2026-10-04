import test from "node:test";
import assert from "node:assert/strict";
import { exportOutline } from "../dist/index.js";
import { reconstruct } from "./helpers.js";

// Multi-parent nodes, a self-loop, an isolated node and two disconnected
// components in one graph.
const mixedGraph = {
  nodes: [
    { id: 1, title: "Root cause", x: 0, y: 0 },
    { id: 2, title: "Factor A", x: 2, y: 1 },
    { id: 3, title: "Factor B", x: 1, y: 3 },
    { id: 4, title: "Shared effect", x: 3, y: 2 },
    { id: 5, title: "Remote X", x: 20, y: 20 },
    { id: 6, title: "Remote Y", x: 22, y: 21 },
    { id: 7, title: "Isolated note", x: 50, y: 50 },
  ],
  edges: [
    { from: 1, to: 2 },
    { from: 1, to: 3 },
    { from: 2, to: 4 },
    { from: 3, to: 4 }, // node 4 has two possible parents
    { from: 4, to: 1 }, // cycle back to node 1
    { from: 2, to: 2 }, // self-loop
    { from: 5, to: 6 },
    { from: 6, to: 5 }, // 2-cycle in the second component
  ],
};

test("hierarchy + references reconstruct the exact node and edge sets", () => {
  const result = exportOutline(mixedGraph);
  const { nodeIds, edgeSet } = reconstruct(result);

  const expectedNodes = mixedGraph.nodes.map((n) => n.id).sort((a, b) => a - b);
  assert.deepEqual([...nodeIds].sort((a, b) => a - b), expectedNodes);
  assert.equal(new Set(nodeIds).size, nodeIds.length, "no node expanded twice");

  const expectedEdges = new Set(mixedGraph.edges.map((e) => `${e.from}->${e.to}`));
  assert.deepEqual(edgeSet, expectedEdges, "parent links + references = original edges");
});

test("every original edge maps to exactly one parent link or reference", () => {
  const result = exportOutline(mixedGraph);
  let parentLinks = 0;
  let references = 0;
  const visit = (entry) => {
    if (entry.parentId !== 0) parentLinks++;
    references += entry.references.length;
    for (const child of entry.children) visit(child);
  };
  for (const root of result.roots) visit(root);
  assert.equal(parentLinks + references, mixedGraph.edges.length);
});

test("references identify targets and never expand them", () => {
  const result = exportOutline(mixedGraph);
  const titles = new Map(mixedGraph.nodes.map((n) => [n.id, n.title]));
  const visit = (entry) => {
    for (const ref of entry.references) {
      assert.ok(titles.has(ref.targetId), `reference target #${ref.targetId} exists`);
      assert.equal(ref.targetTitle, titles.get(ref.targetId));
      assert.equal(typeof ref.targetId, "number");
    }
    for (const child of entry.children) visit(child);
  };
  for (const root of result.roots) visit(root);

  // The self-loop must survive as a reference on its own node.
  const find = (id) => {
    let found;
    const walk = (e) => {
      if (e.nodeId === id) found = e;
      for (const c of e.children) walk(c);
    };
    for (const r of result.roots) walk(r);
    return found;
  };
  const node2 = find(2);
  assert.ok(node2.references.some((r) => r.targetId === 2), "self-loop kept as reference");
});

test("isolated node appears as a top-level entry", () => {
  const result = exportOutline(mixedGraph);
  const isolated = result.roots.find((r) => r.nodeId === 7);
  assert.ok(isolated, "node 7 is a top-level entry");
  assert.equal(isolated.children.length, 0);
  assert.equal(isolated.references.length, 0);
});
