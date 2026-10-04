import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeGlb } from '../src/index.js';
import { BinBuilder, buildGlb, closeTo } from './helpers.js';

function assertBounds(
  result: { bounds: { min: number[]; max: number[] } },
  min: number[],
  max: number[],
): void {
  for (let axis = 0; axis < 3; axis++) {
    assert.ok(
      closeTo(result.bounds.min[axis], min[axis]),
      `min[${axis}] = ${result.bounds.min[axis]}, expected ${min[axis]}`,
    );
    assert.ok(
      closeTo(result.bounds.max[axis], max[axis]),
      `max[${axis}] = ${result.bounds.max[axis]}, expected ${max[axis]}`,
    );
  }
}

test('交错存储 + bufferView 与 accessor 双重偏移 + 索引未引用的极端顶点', () => {
  const bin = new BinBuilder();
  bin.addBytes(new Uint8Array(8)); // bufferView 之前的填充
  const stride = 20;
  const record = (x: number, y: number, z: number): Uint8Array => {
    const buf = new Uint8Array(stride);
    const view = new DataView(buf.buffer);
    // accessor.byteOffset = 4：元素从记录内偏移 4 处开始
    view.setFloat32(4, x, true);
    view.setFloat32(8, y, true);
    view.setFloat32(12, z, true);
    return buf;
  };
  const positions: Array<[number, number, number]> = [
    [0, 0, 0],
    [2, 1, 0],
    [0, 1, 3],
    [1000, 1000, 1000], // 未被索引引用，不得影响结果
  ];
  const interleaved = new Uint8Array(stride * positions.length);
  positions.forEach((p, i) => interleaved.set(record(...p), i * stride));
  const positionsOffset = bin.addBytes(interleaved);
  const indicesOffset = bin.addUint16Array([0, 1, 2]);

  const glb = buildGlb(
    {
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [
        { primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] },
      ],
      accessors: [
        {
          bufferView: 0,
          byteOffset: 4,
          componentType: 5126,
          count: 4,
          type: 'VEC3',
          // 声明的 min/max 包含未引用顶点，必须被忽略
          min: [0, 0, 0],
          max: [1000, 1000, 1000],
        },
        { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: positionsOffset, byteLength: interleaved.length, byteStride: stride },
        { buffer: 0, byteOffset: indicesOffset, byteLength: 6 },
      ],
      buffers: [{ byteLength: 0 }],
    },
    bin.build(),
  );

  const result = analyzeGlb(glb);
  assertBounds(result, [0, 0, 0], [2, 1, 3]);
  assert.deepEqual(result.size, [2, 1, 3]);
});

test('稀疏覆盖改变顶点极值（带基础 bufferView）', () => {
  const bin = new BinBuilder();
  const positionsOffset = bin.addFloat32Array([
    0, 0, 0,
    1, 0, 0,
    0, 1, 0,
    0, 0, 1,
  ]);
  const sparseIndicesOffset = bin.addUint8Array([1]);
  const sparseValuesOffset = bin.addFloat32Array([-5, 2, 0.5]);

  const glb = buildGlb(
    {
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      accessors: [
        {
          bufferView: 0,
          componentType: 5126,
          count: 4,
          type: 'VEC3',
          sparse: {
            count: 1,
            indices: { bufferView: 1, componentType: 5121 },
            values: { bufferView: 2 },
          },
        },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: positionsOffset, byteLength: 48 },
        { buffer: 0, byteOffset: sparseIndicesOffset, byteLength: 1 },
        { buffer: 0, byteOffset: sparseValuesOffset, byteLength: 12 },
      ],
      buffers: [{ byteLength: 0 }],
    },
    bin.build(),
  );

  const result = analyzeGlb(glb);
  assertBounds(result, [-5, 0, 0], [0, 2, 1]);
});

test('稀疏 accessor 无基础 bufferView 时未覆盖元素为零', () => {
  const bin = new BinBuilder();
  const sparseIndicesOffset = bin.addUint16Array([2]);
  const sparseValuesOffset = bin.addFloat32Array([1, 2, 3]);

  const glb = buildGlb(
    {
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      accessors: [
        {
          componentType: 5126,
          count: 3,
          type: 'VEC3',
          sparse: {
            count: 1,
            indices: { bufferView: 0, componentType: 5123 },
            values: { bufferView: 1 },
          },
        },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: sparseIndicesOffset, byteLength: 2 },
        { buffer: 0, byteOffset: sparseValuesOffset, byteLength: 12 },
      ],
      buffers: [{ byteLength: 0 }],
    },
    bin.build(),
  );

  const result = analyzeGlb(glb);
  assertBounds(result, [0, 0, 0], [1, 2, 3]);
});

test('无符号 8 位与 32 位索引', () => {
  const bin = new BinBuilder();
  const positionsOffset = bin.addFloat32Array([
    0, 0, 0,
    1, 0, 0,
    0, 0, 2,
  ]);
  const indices8Offset = bin.addUint8Array([0, 2]);
  const indices32Offset = bin.addUint32Array([1, 2]);

  const glb = buildGlb(
    {
      scenes: [{ nodes: [0, 1] }],
      nodes: [{ mesh: 0 }, { mesh: 1 }],
      meshes: [
        { primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] },
        { primitives: [{ attributes: { POSITION: 0 }, indices: 2 }] },
      ],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
        { bufferView: 1, componentType: 5121, count: 2, type: 'SCALAR' },
        { bufferView: 2, componentType: 5125, count: 2, type: 'SCALAR' },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: positionsOffset, byteLength: 36 },
        { buffer: 0, byteOffset: indices8Offset, byteLength: 2 },
        { buffer: 0, byteOffset: indices32Offset, byteLength: 8 },
      ],
      buffers: [{ byteLength: 0 }],
    },
    bin.build(),
  );

  const result = analyzeGlb(glb);
  assertBounds(result, [0, 0, 0], [1, 0, 2]);
});
