import { test } from "node:test";
import * as assert from "node:assert/strict";
import { analyzeGlb } from "../src/index";
import { buildGlb } from "./glb-builder";

const EPS = 1e-6;
const POSITION_COUNT = 500_000;
const INSTANCE_COUNT = 100;
const EXTRA_CHAIN_NODES = 1900; // total nodes = 1900 + 100 = 2000

// Deterministic LCG for reproducible pseudo-random positions.
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

test("500k positions, 2000 nodes, one mesh instanced 100 times", () => {
  const rand = lcg(42);
  const positions = new Uint8Array(POSITION_COUNT * 12);
  const view = new DataView(positions.buffer);
  const posMin = [Infinity, Infinity, Infinity];
  const posMax = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < POSITION_COUNT; i++) {
    const x = rand() * 4 - 2; // [-2, 2]
    const y = rand(); // [0, 1]
    const z = rand() * 4 - 1; // [-1, 3]
    view.setFloat32(i * 12, x, true);
    view.setFloat32(i * 12 + 4, y, true);
    view.setFloat32(i * 12 + 8, z, true);
    // float32 round-trip for the reference bounds
    const fx = view.getFloat32(i * 12, true);
    const fy = view.getFloat32(i * 12 + 4, true);
    const fz = view.getFloat32(i * 12 + 8, true);
    posMin[0] = Math.min(posMin[0], fx);
    posMin[1] = Math.min(posMin[1], fy);
    posMin[2] = Math.min(posMin[2], fz);
    posMax[0] = Math.max(posMax[0], fx);
    posMax[1] = Math.max(posMax[1], fy);
    posMax[2] = Math.max(posMax[2], fz);
  }

  // Nodes 0..1899: identity chain. Nodes 1900..1999: leaves instancing
  // mesh 0 with translation (j*0.5, j, -j*0.25), hanging off node 1899.
  const nodes: object[] = [];
  for (let i = 0; i < EXTRA_CHAIN_NODES; i++) {
    nodes.push({ children: [i + 1] });
  }
  const leafIds: number[] = [];
  for (let j = 0; j < INSTANCE_COUNT; j++) {
    leafIds.push(EXTRA_CHAIN_NODES + j);
  }
  (nodes[EXTRA_CHAIN_NODES - 1] as { children: number[] }).children = leafIds;
  for (let j = 0; j < INSTANCE_COUNT; j++) {
    nodes.push({ mesh: 0, translation: [j * 0.5, j, -j * 0.25] });
  }

  const glb = buildGlb(
    {
      asset: { version: "2.0" },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes,
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      accessors: [
        { bufferView: 0, componentType: 5126, count: POSITION_COUNT, type: "VEC3" },
      ],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.length }],
      buffers: [{ byteLength: positions.length }],
    },
    positions
  );

  const result = analyzeGlb(glb);

  // Translations are pure offsets; instance j in [0,99]:
  // x offset 0..49.5, y offset 0..99, z offset -24.75..0
  const expectedMin = [posMin[0] + 0, posMin[1] + 0, posMin[2] - 24.75];
  const expectedMax = [posMax[0] + 49.5, posMax[1] + 99, posMax[2] + 0];
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(result.bounds.min[i] - expectedMin[i]) < EPS,
      `min[${i}] expected ${expectedMin[i]} got ${result.bounds.min[i]}`);
    assert.ok(Math.abs(result.bounds.max[i] - expectedMax[i]) < EPS,
      `max[${i}] expected ${expectedMax[i]} got ${result.bounds.max[i]}`);
  }
});
