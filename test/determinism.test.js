import test from "node:test";
import assert from "node:assert/strict";
import { exportOutline } from "../dist/index.js";
import { mulberry32, shuffled } from "./helpers.js";

const graph = {
  nodes: [
    { id: 1, title: "Alpha", x: 0, y: 0 },
    { id: 2, title: "Beta", x: 4, y: 0 },
    { id: 3, title: "Gamma", x: 2, y: 1 },
    { id: 4, title: "Delta", x: 8, y: 0 },
    { id: 5, title: "Epsilon", x: 9, y: 1 },
    { id: 6, title: "Zeta", x: 6, y: 1 },
    { id: 7, title: "Eta", x: 30, y: 30 },
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
    { from: 6, to: 6 },
  ],
};

test("input ordering does not affect hierarchy or Markdown bytes", () => {
  const baseline = exportOutline(graph);
  for (let seed = 1; seed <= 20; seed++) {
    const rand = mulberry32(seed);
    const permuted = {
      nodes: shuffled(graph.nodes, rand),
      edges: shuffled(graph.edges, rand),
    };
    const result = exportOutline(permuted);
    assert.equal(result.markdown, baseline.markdown, `markdown differs at seed ${seed}`);
    assert.deepEqual(
      [...result.parents.entries()].sort((a, b) => a[0] - b[0]),
      [...baseline.parents.entries()].sort((a, b) => a[0] - b[0]),
      `hierarchy differs at seed ${seed}`,
    );
    assert.equal(result.totalCost, baseline.totalCost);
  }
});

test("markdown snapshot is stable", () => {
  const { markdown } = exportOutline(graph);
  const lines = markdown.split("\n");
  assert.ok(markdown.endsWith("\n"));
  assert.equal(lines.length, graph.nodes.length + countReferences(graph) + 1);
  // Full entries are id-tagged, references are marked with an arrow.
  const refs = lines.filter((l) => l.includes("- → "));
  assert.ok(refs.length > 0);
  for (const line of refs) assert.match(line, /\(#\d+\)$/);
});

function countReferences(g) {
  // References = edges not chosen as parent links; counted from the export.
  const { roots } = exportOutline(g);
  let refs = 0;
  const visit = (e) => {
    refs += e.references.length;
    for (const c of e.children) visit(c);
  };
  for (const r of roots) visit(r);
  return refs;
}
