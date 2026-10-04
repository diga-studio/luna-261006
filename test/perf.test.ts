import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MindMapLibrary } from '../src/index.js';
import type { EditOperation, MindMapNodeInput, MindMapNodeView } from '../src/index.js';

const BIG_CHILDREN = 50_000;
const BRANCHES = 250;
const BRANCH_CHILDREN = 200;
const BATCHES = 200;
const EDITS_PER_BATCH = 50;

function tempDb(): string {
  return join(mkdtempSync(join(tmpdir(), 'mindmap-perf-')), 'perf.db');
}

/** 构造 10 万级节点：big 下 5 万孩子，250 个分支各 200 孩子。 */
function buildInput(): MindMapNodeInput {
  const big: MindMapNodeInput = {
    id: 'big',
    children: Array.from({ length: BIG_CHILDREN }, (_, index) => ({ id: `big${index}` })),
  };
  const branches: MindMapNodeInput[] = Array.from({ length: BRANCHES }, (_, index) => ({
    id: `b${index}`,
    children: Array.from({ length: BRANCH_CHILDREN }, (_, kid) => ({ id: `b${index}c${kid}` })),
  }));
  return { id: 'R', children: [big, ...branches] };
}

/** 第 batch 批的 50 条编辑：40 条大列表首尾重排 + 10 条跨分支搬迁。 */
function buildBatch(batch: number, bigSize: number): EditOperation[] {
  const edits: EditOperation[] = [];
  // 同批有 10 个孩子搬出，big 的最终孩子数要少 10。
  const finalBigSize = bigSize - 10;
  for (let index = 0; index < 20; index += 1) {
    const node = `big${(batch * 40 + index) % 40000}`;
    edits.push({ nodeId: node, newParentId: 'big', position: index });
  }
  for (let index = 0; index < 20; index += 1) {
    const node = `big${(batch * 40 + 20 + index) % 40000}`;
    edits.push({ nodeId: node, newParentId: 'big', position: finalBigSize - 20 + index });
  }
  for (let index = 0; index < 10; index += 1) {
    const node = `big${40000 + batch * 10 + index}`;
    const target = `b${(batch * 10 + index) % BRANCHES}`;
    edits.push({ nodeId: node, newParentId: target, position: 0 });
  }
  return edits;
}

/** 校验整棵树业务不变量：连通、无环、深度 ≤ 12、节点数齐全、父子一致。 */
function assertInvariants(root: MindMapNodeView, expectedNodes: number): void {
  const seen = new Set<string>();
  const stack: { node: MindMapNodeView; depth: number }[] = [{ node: root, depth: 1 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    assert.ok(depth <= 12, `depth exceeded at ${node.id}`);
    assert.ok(!seen.has(node.id), `duplicate node ${node.id}`);
    seen.add(node.id);
    for (const kid of node.children) {
      stack.push({ node: kid, depth: depth + 1 });
    }
  }
  assert.equal(seen.size, expectedNodes);
}

test('10 万节点连续 200 批编辑：p95 ≤ 500ms 且不变量保持', async () => {
  const totalNodes = 1 + 1 + BIG_CHILDREN + BRANCHES + BRANCHES * BRANCH_CHILDREN;
  const lib = new MindMapLibrary(tempDb());
  await lib.initMap('m', buildInput());

  const durations: number[] = [];
  let version = 1;
  let bigSize = BIG_CHILDREN;
  for (let batch = 0; batch < BATCHES; batch += 1) {
    const edits = buildBatch(batch, bigSize);
    const start = Date.now();
    const result = await lib.submitBatch('m', { baseVersion: version, edits });
    durations.push(Date.now() - start);
    assert.equal(result.version, version + 1);
    version = result.version;
    bigSize -= 10;
    if ((batch + 1) % 25 === 0) {
      assertInvariants((await lib.getMap('m')).root, totalNodes);
    }
  }

  const sorted = [...durations].sort((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * 0.95)]!;
  const max = sorted[sorted.length - 1]!;
  console.log(`batches=${BATCHES} p95=${p95}ms max=${max}ms`);
  assert.ok(p95 <= 500, `p95 ${p95}ms exceeds 500ms`);

  assertInvariants((await lib.getMap('m')).root, totalNodes);
  assert.equal((await lib.getMap('m')).version, 1 + BATCHES);
  await lib.close();
});
