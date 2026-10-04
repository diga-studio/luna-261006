import test from "node:test";
import assert from "node:assert/strict";
import { exportOutline } from "../dist/index.js";
import { bruteForceOptimum, mulberry32, reconstruct } from "./helpers.js";

function randomGraph(rand, nodeCount, edgeCount) {
  const nodes = [];
  for (let i = 1; i <= nodeCount; i++) {
    nodes.push({
      id: i,
      title: `N${i}`,
      x: Math.floor(rand() * 20),
      y: Math.floor(rand() * 20),
    });
  }
  const edges = [];
  const used = new Set();
  while (edges.length < edgeCount) {
    const from = 1 + Math.floor(rand() * nodeCount);
    const to = 1 + Math.floor(rand() * nodeCount);
    const key = `${from}->${to}`;
    if (used.has(key)) continue;
    used.add(key);
    edges.push({ from, to });
  }
  return { nodes, edges };
}

test("random small graphs match the brute-force global optimum", () => {
  const rand = mulberry32(20261006);
  for (let trial = 0; trial < 150; trial++) {
    const graph = randomGraph(rand, 6, 4 + Math.floor(rand() * 9));
    const result = exportOutline(graph);
    const { best, nodes } = bruteForceOptimum(graph);

    assert.equal(result.roots.length, best.roots, `roots, trial ${trial}`);
    assert.equal(result.totalCost, best.cost, `cost, trial ${trial}`);
    assert.deepEqual(
      nodes.map((n) => result.parents.get(n.id)),
      best.parent,
      `parent sequence, trial ${trial}`,
    );

    const { nodeIds, edgeSet } = reconstruct(result);
    assert.deepEqual(
      [...nodeIds].sort((a, b) => a - b),
      graph.nodes.map((n) => n.id),
      `node set, trial ${trial}`,
    );
    assert.deepEqual(
      edgeSet,
      new Set(graph.edges.map((e) => `${e.from}->${e.to}`)),
      `edge set, trial ${trial}`,
    );
  }
});

test("larger graph completes quickly", () => {
  const rand = mulberry32(42);
  const graph = randomGraph(rand, 300, 900);
  const start = performance.now();
  const result = exportOutline(graph);
  const elapsed = performance.now() - start;
  assert.ok(elapsed < 2000, `took ${elapsed.toFixed(0)}ms`);
  assert.equal(result.parents.size, 300);
});
