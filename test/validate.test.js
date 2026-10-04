import test from "node:test";
import assert from "node:assert/strict";
import { exportOutline } from "../dist/index.js";

const base = {
  nodes: [{ id: 1, title: "A", x: 0, y: 0 }],
  edges: [],
};

test("empty graph yields empty result", () => {
  const result = exportOutline({ nodes: [], edges: [] });
  assert.deepEqual(result.roots, []);
  assert.equal(result.markdown, "");
  assert.equal(result.totalCost, 0);
});

test("single node, no edges", () => {
  const result = exportOutline(base);
  assert.equal(result.roots.length, 1);
  assert.equal(result.markdown, "- A (#1)\n");
});

test("rejects duplicate node ids", () => {
  assert.throws(
    () => exportOutline({ nodes: [...base.nodes, { id: 1, title: "B", x: 1, y: 1 }], edges: [] }),
    /duplicate node id 1/,
  );
});

test("rejects non-positive or non-integer ids", () => {
  for (const id of [0, -3, 1.5, "1"]) {
    assert.throws(
      () => exportOutline({ nodes: [{ id, title: "A", x: 0, y: 0 }], edges: [] }),
      /positive integer/,
    );
  }
});

test("rejects non-integer coordinates", () => {
  assert.throws(
    () => exportOutline({ nodes: [{ id: 1, title: "A", x: 0.5, y: 0 }], edges: [] }),
    /coordinates must be integers/,
  );
});

test("rejects edges with unknown endpoints", () => {
  assert.throws(
    () => exportOutline({ nodes: base.nodes, edges: [{ from: 1, to: 2 }] }),
    /unknown node/,
  );
});

test("rejects duplicate ordered edge pairs", () => {
  const nodes = [
    { id: 1, title: "A", x: 0, y: 0 },
    { id: 2, title: "B", x: 1, y: 1 },
  ];
  assert.throws(
    () => exportOutline({ nodes, edges: [{ from: 1, to: 2 }, { from: 1, to: 2 }] }),
    /duplicate edge 1 -> 2/,
  );
});
