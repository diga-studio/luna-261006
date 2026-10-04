import { test } from "node:test";
import assert from "node:assert/strict";
import { exportOutline } from "../src/index";
import type { CanvasGraph } from "../src/types";
import { bruteForceOptimum } from "./helpers/bruteForce";

/**
 * A chain of overlapping 2-cycles: 1↔2, 2↔3, 3↔4, 4↔5.
 * A greedy "nearest parent" per node locks into the cycles
 * 1↔2 and 3↔4 and can never produce a legal hierarchy.
 *
 * Hand-computed global optimum:
 * - the graph is strongly connected, so 1 top-level entry suffices;
 * - cheapest parent edges: 1→2 (1), 3→4 (1), bridge 2→3 (9), 4→5 (7)
 *   for a total of 18;
 * - lexicographically smallest parent sequence among cost-18 optima
 *   is [0, 1, 2, 3, 4] (a single chain rooted at node 1).
 */
const cycleChain: CanvasGraph = {
  nodes: [
    { id: 1, title: "Alpha", x: 0, y: 0 },
    { id: 2, title: "Beta", x: 1, y: 0 },
    { id: 3, title: "Gamma", x: 10, y: 0 },
    { id: 4, title: "Delta", x: 11, y: 0 },
    { id: 5, title: "Epsilon", x: 5, y: 1 },
  ],
  edges: [
    { from: 1, to: 2 },
    { from: 2, to: 1 },
    { from: 2, to: 3 },
    { from: 3, to: 2 },
    { from: 3, to: 4 },
    { from: 4, to: 3 },
    { from: 4, to: 5 },
    { from: 5, to: 4 },
  ],
};

test("interacting cycles: matches the hand-computed global optimum", () => {
  const result = exportOutline(cycleChain);

  assert.equal(result.entries.length, 1, "top-level entry count");
  assert.equal(result.totalCost, 18, "total spatial cost");
  assert.deepEqual(
    result.parents,
    [
      { nodeId: 1, parentId: 0 },
      { nodeId: 2, parentId: 1 },
      { nodeId: 3, parentId: 2 },
      { nodeId: 4, parentId: 3 },
      { nodeId: 5, parentId: 4 },
    ],
    "parent sequence"
  );
});

test("interacting cycles: matches the independent brute-force optimum", () => {
  const result = exportOutline(cycleChain);
  const optimum = bruteForceOptimum(cycleChain);

  assert.equal(result.entries.length, optimum.rootCount);
  assert.equal(result.totalCost, optimum.totalCost);
  assert.deepEqual(
    result.parents.map((p) => p.parentId),
    optimum.sequence
  );
});

/** Two clusters joined by two bridges of equal cost, with inner cycles. */
const twinClusters: CanvasGraph = {
  nodes: [
    { id: 1, title: "N1", x: 0, y: 0 },
    { id: 2, title: "N2", x: 2, y: 0 },
    { id: 3, title: "N3", x: 1, y: 2 },
    { id: 4, title: "N4", x: 20, y: 0 },
    { id: 5, title: "N5", x: 22, y: 0 },
    { id: 6, title: "N6", x: 21, y: 2 },
  ],
  edges: [
    { from: 1, to: 2 },
    { from: 2, to: 3 },
    { from: 3, to: 1 },
    { from: 2, to: 1 },
    { from: 4, to: 5 },
    { from: 5, to: 6 },
    { from: 6, to: 4 },
    { from: 5, to: 4 },
    { from: 3, to: 6 },
    { from: 6, to: 3 },
    { from: 2, to: 5 },
  ],
};

test("twin clusters: matches the independent brute-force optimum", () => {
  const result = exportOutline(twinClusters);
  const optimum = bruteForceOptimum(twinClusters);

  assert.equal(result.entries.length, optimum.rootCount);
  assert.equal(result.totalCost, optimum.totalCost);
  assert.deepEqual(
    result.parents.map((p) => p.parentId),
    optimum.sequence
  );
});
