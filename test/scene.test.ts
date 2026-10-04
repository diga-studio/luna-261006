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

/** 构造单 mesh GLB 的公共部分：顶点数组 + 节点数组 + 场景数组。 */
function glbWithNodes(
  vertices: number[],
  nodes: object[],
  scenes: object[],
  scene?: number,
  extraMeshes: object[] = [],
): Uint8Array {
  const bin = new BinBuilder();
  const positionsOffset = bin.addFloat32Array(vertices);
  const meshes = [
    { primitives: [{ attributes: { POSITION: 0 } }] },
    ...extraMeshes,
  ];
  return buildGlb(
    {
      ...(scene !== undefined ? { scene } : {}),
      scenes,
      nodes,
      meshes,
      accessors: [
        {
          bufferView: 0,
          componentType: 5126,
          count: vertices.length / 3,
          type: 'VEC3',
        },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: positionsOffset, byteLength: vertices.length * 4 },
      ],
      buffers: [{ byteLength: 0 }],
    },
    bin.build(),
  );
}

test('多层非均匀缩放与旋转（TRS 组合）', () => {
  // N0: t=(10,0,0) s=(2,1,0.5)；N1: t=(0,3,0) 绕Y转90°；N2: mesh s=(1,2,1)
  // 顶点 (x,y,z) -> (2z+10, 2y+3, -0.5x)
  const vertices = [
    1, 0, 0,
    0, 1, 0,
    0, 0, 1,
    -1, -1, -1,
  ];
  const q = Math.SQRT1_2; // 绕 Y 轴 90°： (0, √2/2, 0, √2/2)
  const glb = glbWithNodes(
    vertices,
    [
      { translation: [10, 0, 0], scale: [2, 1, 0.5], children: [1] },
      { translation: [0, 3, 0], rotation: [0, q, 0, q], children: [2] },
      { mesh: 0, scale: [1, 2, 1] },
    ],
    [{ nodes: [0] }],
  );
  const result = analyzeGlb(glb);
  assertBounds(result, [8, 1, -0.5], [12, 5, 0.5]);
});

test('负缩放', () => {
  const vertices = [
    1, 2, 3,
    -4, 0, 1,
  ];
  const glb = glbWithNodes(
    vertices,
    [{ mesh: 0, scale: [-1, 1, 1] }],
    [{ nodes: [0] }],
  );
  const result = analyzeGlb(glb);
  assertBounds(result, [-1, 0, 1], [4, 2, 3]);
});

test('node.matrix 与父 TRS 组合', () => {
  // 子节点 matrix：缩放 2 + 平移 (1,2,3)；父节点缩放 (0.5,1,1)
  const vertices = [
    0, 0, 0,
    1, 1, 1,
  ];
  const glb = glbWithNodes(
    vertices,
    [
      { scale: [0.5, 1, 1], children: [1] },
      {
        mesh: 0,
        matrix: [
          2, 0, 0, 0,
          0, 2, 0, 0,
          0, 0, 2, 0,
          1, 2, 3, 1,
        ],
      },
    ],
    [{ nodes: [0] }],
  );
  const result = analyzeGlb(glb);
  assertBounds(result, [0.5, 2, 3], [1.5, 4, 5]);
});

test('同一 mesh 被多个节点引用时每次出现都是独立实例', () => {
  const vertices = [
    0, 0, 0,
    1, 0, 0,
    0, 1, 0,
  ];
  const glb = glbWithNodes(
    vertices,
    [
      { mesh: 0, translation: [5, 0, 0] },
      { mesh: 0, translation: [0, 0, -2], scale: [3, 3, 3] },
    ],
    [{ nodes: [0, 1] }],
  );
  const result = analyzeGlb(glb);
  assertBounds(result, [0, 0, -2], [6, 3, 0]);
});

test('未选场景与未引用资源不影响结果', () => {
  const bin = new BinBuilder();
  const smallOffset = bin.addFloat32Array([
    0, 0, 0,
    1, 1, 1,
  ]);
  const bigOffset = bin.addFloat32Array([
    -100, -100, -100,
    100, 100, 100,
  ]);
  const glb = buildGlb(
    {
      scene: 1,
      scenes: [
        { nodes: [0] }, // 未选场景：巨大模型
        { nodes: [1] }, // 默认场景：小模型
      ],
      nodes: [
        { mesh: 1 },
        { mesh: 0 },
        { mesh: 1 }, // 不属于任何场景
      ],
      meshes: [
        { primitives: [{ attributes: { POSITION: 0 } }] },
        { primitives: [{ attributes: { POSITION: 1 } }] },
        { primitives: [{ attributes: { POSITION: 1 } }] }, // 完全未引用
      ],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 2, type: 'VEC3' },
        { bufferView: 1, componentType: 5126, count: 2, type: 'VEC3' },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: smallOffset, byteLength: 24 },
        { buffer: 0, byteOffset: bigOffset, byteLength: 24 },
      ],
      buffers: [{ byteLength: 0 }],
    },
    bin.build(),
  );
  const result = analyzeGlb(glb);
  assertBounds(result, [0, 0, 0], [1, 1, 1]);
});

test('未声明默认场景时使用第一个场景', () => {
  const vertices = [
    0, 0, 0,
    2, 2, 2,
  ];
  const glb = glbWithNodes(
    vertices,
    [{ mesh: 0 }],
    [{ nodes: [0] }],
    undefined,
  );
  const result = analyzeGlb(glb);
  assertBounds(result, [0, 0, 0], [2, 2, 2]);
});
