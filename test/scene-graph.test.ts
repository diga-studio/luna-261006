import { test } from "node:test";
import * as assert from "node:assert/strict";
import { analyzeGlb } from "../src/index";
import { buildGlb, f32 } from "./glb-builder";

const EPS = 1e-9;
const SQRT1_2 = Math.SQRT1_2;

// Mesh A: unit triangle, no indices.
const bin = f32([1, 0, 0, 0, 1, 0, 0, 0, 1]);
const meshes = [{ primitives: [{ attributes: { POSITION: 0 } }] }];
const accessors = [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3" }];
const bufferViews = [{ buffer: 0, byteOffset: 0, byteLength: 36 }];

function makeGlb(sceneField: number | undefined, scenes: object[], nodes: object[]): Uint8Array {
  const json: Record<string, unknown> = {
    asset: { version: "2.0" },
    scenes,
    nodes,
    meshes,
    accessors,
    bufferViews,
    buffers: [{ byteLength: bin.length }],
  };
  if (sceneField !== undefined) {
    json.scene = sceneField;
  }
  return buildGlb(json, bin);
}

// Hand-computed expectations:
// root = T(10,3,-4) * R_y(90deg) * S(2,1,0.5)
// child1 = T(1,0,0) * S(-1,2,1)   -> verts (10,3,-4) (10,5,-6) (10.5,3,-6)
// child2 = T(0,0,2)               -> verts (11,3,-6) (11,4,-4) (11.5,3,-4)
// child3 = matrix T(0,10,0)       -> verts (10,13,-6) (10,14,-4) (10.5,13,-4)
const hierarchyNodes = [
  {
    translation: [10, 3, -4],
    rotation: [0, SQRT1_2, 0, SQRT1_2],
    scale: [2, 1, 0.5],
    children: [1, 2, 3],
  },
  { mesh: 0, translation: [1, 0, 0], scale: [-1, 2, 1] },
  { mesh: 0, translation: [0, 0, 2] },
  { mesh: 0, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 10, 0, 1] },
  // node 4: only reachable from the unselected scene
  { mesh: 0, scale: [1000, 1000, 1000] },
];
const EXPECTED_MIN = [10, 3, -6];
const EXPECTED_MAX = [11.5, 14, -4];

function expectBounds(
  result: { bounds: { min: number[]; max: number[] }; dimensions: number[] },
  min: number[],
  max: number[]
): void {
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(result.bounds.min[i] - min[i]) < EPS,
      `min[${i}] expected ${min[i]} got ${result.bounds.min[i]}`);
    assert.ok(Math.abs(result.bounds.max[i] - max[i]) < EPS,
      `max[${i}] expected ${max[i]} got ${result.bounds.max[i]}`);
    assert.ok(Math.abs(result.dimensions[i] - (max[i] - min[i])) < EPS,
      `dim[${i}] expected ${max[i] - min[i]} got ${result.dimensions[i]}`);
  }
}

test("multi-instance hierarchy with rotation, non-uniform and negative scale, matrix node", () => {
  const glb = makeGlb(0, [{ nodes: [0] }, { nodes: [4] }], hierarchyNodes);
  expectBounds(analyzeGlb(glb), EXPECTED_MIN, EXPECTED_MAX);
});

test("unselected scene is ignored and first scene is the default", () => {
  // no `scene` field: scenes[0] must be used; scenes[1] holds the 1000x node.
  const glb = makeGlb(undefined, [{ nodes: [0] }, { nodes: [4] }], hierarchyNodes);
  expectBounds(analyzeGlb(glb), EXPECTED_MIN, EXPECTED_MAX);
});

test("explicitly selecting the second scene yields its own bounds", () => {
  const glb = makeGlb(1, [{ nodes: [0] }, { nodes: [4] }], hierarchyNodes);
  // mesh scaled by 1000: verts (1000,0,0) (0,1000,0) (0,0,1000)
  expectBounds(analyzeGlb(glb), [0, 0, 0], [1000, 1000, 1000]);
});
