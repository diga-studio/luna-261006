import { test } from "node:test";
import assert from "node:assert/strict";
import { exportOutline } from "../src/index";
import type { CanvasGraph, OutlineEntry, OutlineResult } from "../src/types";

/**
 * Mixed graph: multi-parent node (2 has incoming from 1 and 3),
 * a self-loop (2→2), an isolated node (4), and a disconnected
 * component (5↔6).
 */
const mixedGraph: CanvasGraph = {
  nodes: [
    { id: 1, title: "Root Cause", x: 0, y: 0 },
    { id: 2, title: "Shared Effect", x: 3, y: 1 },
    { id: 3, title: "Side Cause", x: 6, y: 0 },
    { id: 4, title: "Lonely", x: 100, y: 100 },
    { id: 5, title: "Loop A", x: 0, y: 50 },
    { id: 6, title: "Loop B", x: 1, y: 50 },
  ],
  edges: [
    { from: 1, to: 2 },
    { from: 3, to: 2 },
    { from: 2, to: 2 },
    { from: 5, to: 6 },
    { from: 6, to: 5 },
  ],
};

function reconstruct(result: OutlineResult): {
  nodeIds: number[];
  edges: Array<{ from: number; to: number }>;
} {
  const nodeIds: number[] = [];
  const edges: Array<{ from: number; to: number }> = [];
  const visit = (entry: OutlineEntry, parentId: number): void => {
    nodeIds.push(entry.id);
    if (parentId !== 0) {
      edges.push({ from: parentId, to: entry.id });
    }
    for (const child of entry.children) {
      visit(child, entry.id);
    }
    for (const reference of entry.references) {
      edges.push({ from: entry.id, to: reference.targetId });
    }
  };
  for (const entry of result.entries) {
    visit(entry, 0);
  }
  return { nodeIds, edges };
}

const edgeKey = (edge: { from: number; to: number }): string =>
  `${edge.from}->${edge.to}`;

test("mixed graph: hierarchy + references reconstruct the original graph", () => {
  const result = exportOutline(mixedGraph);
  const { nodeIds, edges } = reconstruct(result);

  const expectedNodeIds = mixedGraph.nodes.map((node) => node.id).sort((a, b) => a - b);
  assert.deepEqual(
    [...nodeIds].sort((a, b) => a - b),
    expectedNodeIds,
    "node set reconstructed from full entries"
  );
  assert.equal(
    new Set(nodeIds).size,
    nodeIds.length,
    "every node appears exactly once as a full entry"
  );

  const expectedEdges = new Set(mixedGraph.edges.map(edgeKey));
  const actualEdges = new Set(edges.map(edgeKey));
  assert.deepEqual(actualEdges, expectedEdges, "edge set reconstructed exactly");
  assert.equal(actualEdges.size, edges.length, "no duplicated edges");
});

test("mixed graph: structural invariants", () => {
  const result = exportOutline(mixedGraph);

  // Isolated node must be a top-level entry.
  const topLevelIds = result.entries.map((entry) => entry.id);
  assert.ok(topLevelIds.includes(4), "isolated node is top-level");

  // Self-loop 2->2 survives as a reference anchored at node 2.
  const find = (entries: OutlineEntry[], id: number): OutlineEntry | undefined => {
    for (const entry of entries) {
      if (entry.id === id) {
        return entry;
      }
      const hit = find(entry.children, id);
      if (hit) {
        return hit;
      }
    }
    return undefined;
  };
  const entry2 = find(result.entries, 2)!;
  assert.ok(
    entry2.references.some((reference) => reference.targetId === 2),
    "self-loop kept as a reference"
  );

  // The multi-parent node keeps exactly one parent; the other incoming
  // edge (3->2 or 1->2) survives as a reference on its source.
  const parents = new Map(result.parents.map((p) => [p.nodeId, p.parentId]));
  const chosen = parents.get(2)!;
  assert.ok(chosen === 1 || chosen === 3, "parent of node 2 uses an original edge");
  const other = chosen === 1 ? 3 : 1;
  const otherEntry = find(result.entries, other)!;
  assert.ok(
    otherEntry.references.some((reference) => reference.targetId === 2),
    "unchosen incoming edge kept as a reference"
  );

  // Parent assignments are acyclic.
  for (const { nodeId } of result.parents) {
    let current = nodeId;
    for (let steps = 0; steps <= result.parents.length; steps++) {
      const parent = parents.get(current)!;
      if (parent === 0) {
        break;
      }
      assert.notEqual(steps, result.parents.length, "hierarchy must be acyclic");
      current = parent;
    }
  }
});

function permuted(graph: CanvasGraph, seed: number): CanvasGraph {
  const shuffle = <T>(items: T[]): T[] => {
    const result = [...items];
    let state = seed;
    for (let i = result.length - 1; i > 0; i--) {
      state = (state * 1103515245 + 12345) % 2147483648;
      const j = state % (i + 1);
      [result[i], result[j]] = [result[j]!, result[i]!];
    }
    return result;
  };
  return { nodes: shuffle(graph.nodes), edges: shuffle(graph.edges) };
}

test("input ordering does not affect the result", () => {
  const baseline = exportOutline(mixedGraph);
  for (const seed of [1, 7, 42, 2024]) {
    const result = exportOutline(permuted(mixedGraph, seed));
    assert.deepEqual(result.parents, baseline.parents, `parents (seed ${seed})`);
    assert.equal(result.markdown, baseline.markdown, `markdown bytes (seed ${seed})`);
    assert.equal(result.totalCost, baseline.totalCost, `cost (seed ${seed})`);
  }
});

test("markdown rendering is stable and identifies reference targets", () => {
  const result = exportOutline(mixedGraph);
  const lines = result.markdown.split("\n").filter((line) => line.length > 0);

  const fullLines = lines.filter((line) => !line.includes("→"));
  const referenceLines = lines.filter((line) => line.includes("→"));
  assert.equal(fullLines.length, mixedGraph.nodes.length, "one line per full entry");
  assert.equal(
    fullLines.length + referenceLines.length,
    mixedGraph.nodes.length + (mixedGraph.edges.length - (mixedGraph.nodes.length - result.entries.length)),
    "every edge is either a parent-child link or a reference line"
  );
  for (const line of referenceLines) {
    assert.match(line, /\(ID: \d+\)/, "reference identifies the target node id");
  }
});

test("invalid input is rejected", () => {
  assert.throws(() =>
    exportOutline({ nodes: [{ id: 0, title: "x", x: 0, y: 0 }], edges: [] })
  );
  assert.throws(() =>
    exportOutline({
      nodes: [
        { id: 1, title: "a", x: 0, y: 0 },
        { id: 1, title: "b", x: 1, y: 1 },
      ],
      edges: [],
    })
  );
  assert.throws(() =>
    exportOutline({
      nodes: [{ id: 1, title: "a", x: 0, y: 0 }],
      edges: [{ from: 1, to: 2 }],
    })
  );
  assert.throws(() =>
    exportOutline({
      nodes: [
        { id: 1, title: "a", x: 0, y: 0 },
        { id: 2, title: "b", x: 1, y: 1 },
      ],
      edges: [
        { from: 1, to: 2 },
        { from: 1, to: 2 },
      ],
    })
  );
});
