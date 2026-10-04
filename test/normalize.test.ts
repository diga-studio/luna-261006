import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeGlb, normalizeGlb } from '../src/index.js';
import { BinBuilder, buildGlb, closeTo } from './helpers.js';

/** 4m × 2m × 1m 的盒子：x∈[1,5]，y∈[2,4]，z∈[-0.5,0.5]。 */
function boxGlb(): Uint8Array {
  const vertices = [
    1, 2, -0.5,
    5, 2, -0.5,
    1, 4, -0.5,
    1, 2, 0.5,
    5, 4, 0.5,
    5, 2, 0.5,
    1, 4, 0.5,
    5, 4, -0.5,
  ];
  const bin = new BinBuilder();
  const positionsOffset = bin.addFloat32Array(vertices);
  return buildGlb(
    {
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 8, type: 'VEC3' },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: positionsOffset, byteLength: vertices.length * 4 },
      ],
      buffers: [{ byteLength: 0 }],
    },
    bin.build(),
  );
}

test('4m×2m×1m 模型归一化到 200cm×150cm×200cm 内', () => {
  const glb = boxGlb();
  const before = Uint8Array.from(glb);

  const analysis = analyzeGlb(glb);
  assert.deepEqual(analysis.size, [4, 2, 1]);

  const result = normalizeGlb(glb, 200, 150, 200);

  // 最大统一缩放 = min(2/4, 1.5/2, 2/1) = 0.5
  assert.ok(closeTo(result.size[0], 2), `size[0] = ${result.size[0]}`);
  assert.ok(closeTo(result.size[1], 1), `size[1] = ${result.size[1]}`);
  assert.ok(closeTo(result.size[2], 0.5), `size[2] = ${result.size[2]}`);

  // 最低点位于 y=0，xz 中心位于原点
  assert.ok(closeTo(result.bounds.min[1], 0), `min y = ${result.bounds.min[1]}`);
  assert.ok(closeTo((result.bounds.min[0] + result.bounds.max[0]) / 2, 0));
  assert.ok(closeTo((result.bounds.min[2] + result.bounds.max[2]) / 2, 0));
  assert.ok(closeTo(result.bounds.min[0], -1));
  assert.ok(closeTo(result.bounds.max[0], 1));
  assert.ok(closeTo(result.bounds.min[2], -0.25));
  assert.ok(closeTo(result.bounds.max[2], 0.25));

  // 矩阵为列主序、作用于列向量：M = S(0.5) * T(-3, -2, 0)
  assert.equal(result.matrix.length, 16);
  const m = result.matrix;
  const transformed = (x: number, y: number, z: number): number[] => [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
  const cornerMin = transformed(1, 2, -0.5);
  const cornerMax = transformed(5, 4, 0.5);
  assert.ok(closeTo(cornerMin[0], -1) && closeTo(cornerMin[1], 0) && closeTo(cornerMin[2], -0.25));
  assert.ok(closeTo(cornerMax[0], 1) && closeTo(cornerMax[1], 1) && closeTo(cornerMax[2], 0.25));

  // 原文件保持不变
  assert.deepEqual(glb, before);
});

test('目标尺寸非正时抛错', () => {
  const glb = boxGlb();
  assert.throws(() => normalizeGlb(glb, 0, 150, 200));
  assert.throws(() => normalizeGlb(glb, 200, -1, 200));
});
