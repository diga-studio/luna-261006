import { test } from "node:test";
import * as assert from "node:assert/strict";
import { analyzeGlb } from "../src/index";
import { buildGlb, concat, f32, u8, u16, u32 } from "./glb-builder";

const EPS = 1e-9;

function expectBounds(
  result: { bounds: { min: number[]; max: number[] }; dimensions: number[] },
  min: number[],
  max: number[]
): void {
  for (let i = 0; i < 3; i++) {
    assert.ok(
      Math.abs(result.bounds.min[i] - min[i]) < EPS,
      `min[${i}] expected ${min[i]} got ${result.bounds.min[i]}`
    );
    assert.ok(
      Math.abs(result.bounds.max[i] - max[i]) < EPS,
      `max[${i}] expected ${max[i]} got ${result.bounds.max[i]}`
    );
    assert.ok(
      Math.abs(result.dimensions[i] - (max[i] - min[i])) < EPS,
      `dim[${i}] expected ${max[i] - min[i]} got ${result.dimensions[i]}`
    );
  }
}

function singleNodeGlb(
  json: Partial<Record<string, unknown>> & object,
  bin: Uint8Array
): Uint8Array {
  return buildGlb(
    {
      asset: { version: "2.0" },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      ...json,
    },
    bin
  );
}

test("interleaved positions with bufferView and accessor byte offsets", () => {
  // bufferView starts 8 bytes into the BIN; accessor adds 4 more bytes;
  // stride 16 = 12 bytes position + 4 bytes padding.
  const bin = concat([
    u8([0xde, 0xad, 0xbe, 0xef, 1, 2, 3, 4]), // 8 bytes garbage prefix
    u8([9, 9, 9, 9]), // 4 bytes garbage (accessor byteOffset skips this)
    f32([1, 2, 3]), u8([7, 7, 7, 7]),
    f32([-1, 0, 5]), u8([7, 7, 7, 7]),
  ]);
  const glb = singleNodeGlb(
    {
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      accessors: [
        {
          bufferView: 0,
          byteOffset: 4,
          componentType: 5126,
          count: 2,
          type: "VEC3",
        },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: 8, byteLength: 36, byteStride: 16 },
      ],
      buffers: [{ byteLength: bin.length }],
    },
    bin
  );
  expectBounds(analyzeGlb(glb), [-1, 0, 3], [1, 2, 5]);
});

test("sparse overrides on top of a base bufferView", () => {
  const bin = concat([
    f32([0, 0, 0, 1, 1, 1, 2, 2, 2]), // base positions
    u16([1]), // sparse indices -> element 1
    u8([0, 0]), // align to 4
    f32([-5, 10, 3]), // sparse values
  ]);
  const glb = singleNodeGlb(
    {
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      accessors: [
        {
          bufferView: 0,
          componentType: 5126,
          count: 3,
          type: "VEC3",
          sparse: {
            count: 1,
            indices: { bufferView: 1, componentType: 5123 },
            values: { bufferView: 2 },
          },
        },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: 36 },
        { buffer: 0, byteOffset: 36, byteLength: 2 },
        { buffer: 0, byteOffset: 40, byteLength: 12 },
      ],
      buffers: [{ byteLength: bin.length }],
    },
    bin
  );
  expectBounds(analyzeGlb(glb), [-5, 0, 0], [2, 10, 3]);
});

test("sparse accessor without base bufferView leaves uncovered elements zero", () => {
  const bin = concat([
    u8([2]), // sparse indices (u8) -> element 2
    u8([0, 0, 0]), // align
    f32([4, -2, 1]), // sparse values
  ]);
  const glb = singleNodeGlb(
    {
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      accessors: [
        {
          componentType: 5126,
          count: 3,
          type: "VEC3",
          sparse: {
            count: 1,
            indices: { bufferView: 0, componentType: 5121 },
            values: { bufferView: 1 },
          },
        },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: 1 },
        { buffer: 0, byteOffset: 4, byteLength: 12 },
      ],
      buffers: [{ byteLength: bin.length }],
    },
    bin
  );
  expectBounds(analyzeGlb(glb), [0, -2, 0], [4, 0, 1]);
});

test("indexed primitive ignores unreferenced extreme vertices", () => {
  const bin = concat([
    f32([0, 0, 0, 1, 1, 1, 1000, -1000, 1000]), // vertex 2 never referenced
    u16([0, 1, 1]),
    u8([0, 0]),
    u32([0, 1, 0]), // second primitive's u32 indices
  ]);
  const glb = singleNodeGlb(
    {
      meshes: [
        {
          primitives: [
            { attributes: { POSITION: 0 }, indices: 1 },
            { attributes: { POSITION: 0 }, indices: 2 },
          ],
        },
      ],
      accessors: [
        {
          bufferView: 0,
          componentType: 5126,
          count: 3,
          type: "VEC3",
          min: [0, -1000, 0], // deliberately misleading declared min/max
          max: [1000, 1, 1000],
        },
        { bufferView: 1, componentType: 5123, count: 3, type: "SCALAR" },
        { bufferView: 2, componentType: 5125, count: 3, type: "SCALAR" },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: 36 },
        { buffer: 0, byteOffset: 36, byteLength: 6 },
        { buffer: 0, byteOffset: 44, byteLength: 12 },
      ],
      buffers: [{ byteLength: bin.length }],
    },
    bin
  );
  expectBounds(analyzeGlb(glb), [0, 0, 0], [1, 1, 1]);
});

test("u8 indices", () => {
  const bin = concat([f32([5, 6, 7, -5, -6, -7]), u8([1, 0, 1])]);
  const glb = singleNodeGlb(
    {
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 2, type: "VEC3" },
        { bufferView: 1, componentType: 5121, count: 3, type: "SCALAR" },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: 24 },
        { buffer: 0, byteOffset: 24, byteLength: 3 },
      ],
      buffers: [{ byteLength: bin.length }],
    },
    bin
  );
  expectBounds(analyzeGlb(glb), [-5, -6, -7], [5, 6, 7]);
});
