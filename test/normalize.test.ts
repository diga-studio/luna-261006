import { test } from "node:test";
import * as assert from "node:assert/strict";
import { normalizeGlb } from "../src/index";
import { buildGlb, f32 } from "./glb-builder";

const EPS = 1e-9;

// 4m x 2m x 1m box, offset away from the origin:
// x in [1,5], y in [-3,-1], z in [2,3].
const bin = f32([
  1, -3, 2,
  5, -3, 2,
  1, -1, 2,
  1, -3, 3,
  5, -1, 3,
  5, -3, 3,
  1, -1, 3,
  5, -1, 2,
]);

function makeGlb(): Uint8Array {
  return buildGlb(
    {
      asset: { version: "2.0" },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 8, type: "VEC3" }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 96 }],
      buffers: [{ byteLength: bin.length }],
    },
    bin
  );
}

test("normalizes a 4x2x1 m model into a 200x150x200 cm target", () => {
  const glb = makeGlb();
  const before = Uint8Array.from(glb);

  const result = normalizeGlb(glb, [200, 150, 200]);

  // scale = min(2/4, 1.5/2, 2/1) = 0.5 -> dims 2 x 1 x 0.5 m
  assert.ok(Math.abs(result.dimensions[0] - 2) < EPS, `dim x ${result.dimensions[0]}`);
  assert.ok(Math.abs(result.dimensions[1] - 1) < EPS, `dim y ${result.dimensions[1]}`);
  assert.ok(Math.abs(result.dimensions[2] - 0.5) < EPS, `dim z ${result.dimensions[2]}`);

  // lowest point at y=0, xz centered at origin
  assert.ok(Math.abs(result.bounds.min[1] - 0) < EPS, `min y ${result.bounds.min[1]}`);
  assert.ok(Math.abs(result.bounds.max[1] - 1) < EPS, `max y ${result.bounds.max[1]}`);
  assert.ok(Math.abs(result.bounds.min[0] + 1) < EPS, `min x ${result.bounds.min[0]}`);
  assert.ok(Math.abs(result.bounds.max[0] - 1) < EPS, `max x ${result.bounds.max[0]}`);
  assert.ok(Math.abs(result.bounds.min[2] + 0.25) < EPS, `min z ${result.bounds.min[2]}`);
  assert.ok(Math.abs(result.bounds.max[2] - 0.25) < EPS, `max z ${result.bounds.max[2]}`);

  // matrix: uniform scale 0.5, translation (-1.5, 1.5, -1.25), column-major
  const expected = [
    0.5, 0, 0, 0,
    0, 0.5, 0, 0,
    0, 0, 0.5, 0,
    -1.5, 1.5, -1.25, 1,
  ];
  assert.equal(result.matrix.length, 16);
  for (let i = 0; i < 16; i++) {
    assert.ok(Math.abs(result.matrix[i] - expected[i]) < EPS,
      `matrix[${i}] expected ${expected[i]} got ${result.matrix[i]}`);
  }

  // original bytes untouched
  assert.deepEqual(glb, before);
});
