import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import {
  MindMapService,
  type EditOp,
  type InitNode,
  type MapSnapshot,
} from '../src/mindmap.js';

const FLAT_COUNT = 50_000; // 根节点下的扁平孩子（大孩子列表）
const BRANCH_COUNT = 100; // 分支数
const BRANCH_KIDS = 499; // 每个分支的孩子数
const BATCHES = 200;
const EDITS_PER_BATCH = 50;
const REORDER_POOL = 10_000; // 专用于根下重排的节点池
const SWAP_PAIRS_PER_BATCH = 15;

function buildTree(): InitNode {
  const flat: InitNode[] = Array.from({ length: FLAT_COUNT }, (_, i) => ({
    id: `f${i}`,
  }));
  const branches: InitNode[] = Array.from({ length: BRANCH_COUNT }, (_, b) => ({
    id: `b${b}`,
    children: Array.from({ length: BRANCH_KIDS }, (_, j) => ({
      id: `b${b}k${j}`,
    })),
  }));
  return { id: 'R', children: [...flat, ...branches] };
}

/** 全量不变量校验：连通、无环、深度 <= 12、父子关系与孩子顺序互洽。 */
function assertInvariants(snap: MapSnapshot): void {
  const ids = Object.keys(snap.parents);
  // 父引用必须存在且唯一根
  for (const id of ids) {
    const p = snap.parents[id];
    if (p === null) {
      assert.equal(id, snap.rootId, '只有根没有父节点');
    } else {
      assert.ok(snap.parents[p] !== undefined, `父节点 ${p} 必须存在`);
    }
  }
  // 孩子列表与父指针互洽，且每个节点只出现一次
  const seen = new Set<string>();
  for (const [parentId, kids] of Object.entries(snap.children)) {
    for (const kid of kids) {
      assert.equal(snap.parents[kid], parentId, '孩子列表与父指针必须一致');
      assert.ok(!seen.has(kid), '节点只能出现在一个孩子列表中');
      seen.add(kid);
    }
  }
  assert.equal(seen.size, ids.length - 1, '除根外每个节点都出现一次');
  // 深度 <= 12 且无环（沿父指针必然到达根）
  const depth = new Map<string, number>([[snap.rootId, 1]]);
  for (const id of ids) {
    if (depth.has(id)) continue;
    const path: string[] = [];
    const inPath = new Set<string>();
    let cur = id;
    let known = depth.get(cur);
    while (known === undefined) {
      assert.ok(!inPath.has(cur), '不允许成环');
      inPath.add(cur);
      path.push(cur);
      const p = snap.parents[cur];
      assert.notEqual(p, null, '必须连通到根');
      cur = p as string;
      known = depth.get(cur);
    }
    let d = known;
    for (let i = path.length - 1; i >= 0; i--) {
      d += 1;
      assert.ok(d <= 12, `节点 ${path[i]} 深度 ${d} 超过 12`);
      depth.set(path[i], d);
    }
  }
}

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index];
}

test(
  '大规模连续编辑：10万节点、5万孩子列表，200批×50编辑 p95 <= 500ms',
  { timeout: 300_000 },
  () => {
    const service = new MindMapService(':memory:');
    service.initMap('big', buildTree());

    const durations: number[] = [];
    let version = 1;
    for (let t = 0; t < BATCHES; t++) {
      const edits: EditOp[] = [];
      // 根的最终孩子数保持 FLAT_COUNT + BRANCH_COUNT 不变，
      // 指向根的编辑各自占据互不重复的首尾位置
      const lastPos = FLAT_COUNT + BRANCH_COUNT - 1;
      let head = 0;
      let tail = 0;
      const nextHead = (): number => head++;
      const nextTail = (): number => lastPos - tail++;
      // 20 项：大孩子列表内的首尾重排（同父，指定位置必须生效）
      for (let i = 0; i < 20; i++) {
        const nodeId = `f${(t * 20 + i) % REORDER_POOL}`;
        edits.push({
          nodeId,
          newParentId: 'R',
          position: i % 2 === 0 ? nextHead() : nextTail(),
        });
      }
      // 15 对：跨分支搬迁（扁平节点进分支，分支孩子回根下）
      for (let j = 0; j < SWAP_PAIRS_PER_BATCH; j++) {
        const index = t * SWAP_PAIRS_PER_BATCH + j;
        const flatId = `f${REORDER_POOL + index}`;
        const branchId = `b${index % BRANCH_COUNT}`;
        const branchKidId = `${branchId}k${Math.floor(index / BRANCH_COUNT)}`;
        edits.push({ nodeId: flatId, newParentId: branchId, position: 0 });
        edits.push({
          nodeId: branchKidId,
          newParentId: 'R',
          position: j % 2 === 0 ? nextHead() : nextTail(),
        });
      }
      assert.equal(edits.length, EDITS_PER_BATCH);

      const start = performance.now();
      const result = service.submitBatch('big', version, edits);
      durations.push(performance.now() - start);

      assert.deepEqual(result, { ok: true, version: version + 1 });
      version += 1;
      // 每次成功后整棵树必须满足全部业务不变量
      assertInvariants(service.readMap('big'));
    }

    const p95 = percentile(durations, 95);
    const p50 = percentile(durations, 50);
    console.log(
      `  批次耗时：p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms max=${Math.max(...durations).toFixed(1)}ms`,
    );
    assert.ok(p95 <= 500, `p95 ${p95.toFixed(1)}ms 超过 500ms`);
    service.close();
  },
);
