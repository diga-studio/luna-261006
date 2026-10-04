import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeGlb } from '../src/index.js';
import { BinBuilder, buildGlb, closeTo } from './helpers.js';

const POSITION_COUNT = 500_000;
const NODE_COUNT = 2000;
const INSTANCE_COUNT = 100;

/** 确定性伪随机数（mulberry32）。 */
function rng(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildLargeGlb(): Uint8Array {
  const random = rng(42);
  const positions = new Float32Array(POSITION_COUNT * 3);
  // 已知极值顶点
  positions[0] = 0;
  positions[1] = 0;
  positions[2] = 0;
  positions[3] = 1;
  positions[4] = 2;
  positions[5] = 0.5;
  for (let i = 2; i < POSITION_COUNT; i++) {
    positions[i * 3] = 0.001 + random() * 0.998;
    positions[i * 3 + 1] = 0.001 + random() * 1.998;
    positions[i * 3 + 2] = 0.001 + random() * 0.498;
  }

  const bin = new BinBuilder();
  const positionsOffset = bin.addFloat32Array(positions);
  // 尾部填充未引用字节，使文件达到 64 MiB 规模
  bin.addBytes(new Uint8Array(64 * 1024 * 1024));

  // 2000 个节点：0 为根，1..1899 为无网格变换节点，
  // 1900..1999 共 100 个节点引用同一 mesh，各自带 x 方向平移。
  const nodes: object[] = [];
  const children: number[] = [];
  for (let i = 1; i < NODE_COUNT; i++) {
    children.push(i);
  }
  nodes.push({ children });
  for (let i = 1; i < NODE_COUNT - INSTANCE_COUNT; i++) {
    nodes.push({ translation: [0.001 * (i % 7), 0, 0.002 * (i % 5)] });
  }
  for (let i = 0; i < INSTANCE_COUNT; i++) {
    nodes.push({ mesh: 0, translation: [i * 0.01, 0, 0] });
  }

  return buildGlb(
    {
      scenes: [{ nodes: [0] }],
      nodes,
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      accessors: [
        {
          bufferView: 0,
          componentType: 5126,
          count: POSITION_COUNT,
          type: 'VEC3',
        },
      ],
      bufferViews: [
        {
          buffer: 0,
          byteOffset: positionsOffset,
          byteLength: POSITION_COUNT * 12,
        },
      ],
      buffers: [{ byteLength: 0 }],
    },
    bin.build(),
  );
}

test('规模：64 MiB 文件、50 万位置、2000 节点、100 实例', () => {
  const glb = buildLargeGlb();
  assert.ok(glb.byteLength >= 64 * 1024 * 1024);

  const gc = (globalThis as { gc?: () => void }).gc;
  gc?.();
  const heapBefore = process.memoryUsage().heapUsed;

  const result = analyzeGlb(glb);

  gc?.();
  const heapAfter = process.memoryUsage().heapUsed;

  // 100 个实例：第 i 个实例 x 方向平移 i*0.01，最大 0.99
  assert.ok(closeTo(result.bounds.min[0], 0), `min x = ${result.bounds.min[0]}`);
  assert.ok(closeTo(result.bounds.min[1], 0), `min y = ${result.bounds.min[1]}`);
  assert.ok(closeTo(result.bounds.min[2], 0), `min z = ${result.bounds.min[2]}`);
  assert.ok(closeTo(result.bounds.max[0], 1.99), `max x = ${result.bounds.max[0]}`);
  assert.ok(closeTo(result.bounds.max[1], 2), `max y = ${result.bounds.max[1]}`);
  assert.ok(closeTo(result.bounds.max[2], 0.5), `max z = ${result.bounds.max[2]}`);

  // 额外工作内存（不含原始文件字节）不超过 96 MiB
  const heapDelta = heapAfter - heapBefore;
  assert.ok(
    heapDelta < 96 * 1024 * 1024,
    `heap delta ${(heapDelta / 1024 / 1024).toFixed(1)} MiB exceeds 96 MiB`,
  );
});
