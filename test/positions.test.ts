import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MindMapService,
  type EditOp,
  type InitNode,
  type MapSnapshot,
} from '../src/mindmap.js';

/**
 * 测试内独立的参考实现：仅依据编辑前快照与位置规则，
 * 计算每个受影响父节点的最终孩子列表。
 */
function referenceChildren(
  snap: MapSnapshot,
  edits: EditOp[],
): Record<string, string[]> {
  const editByNode = new Map(edits.map((e) => [e.nodeId, e]));
  const finalParentOf = (id: string): string | null =>
    editByNode.get(id)?.newParentId ?? snap.parents[id];
  const affected = new Set<string>();
  for (const e of edits) {
    affected.add(e.newParentId);
    const old = snap.parents[e.nodeId];
    if (old !== null) affected.add(old);
  }
  const result: Record<string, string[]> = {};
  for (const p of affected) {
    const staying = (snap.children[p] ?? []).filter(
      (c) => finalParentOf(c) === p,
    );
    const targets = edits.filter((e) => e.newParentId === p);
    const incoming = targets.filter((e) => snap.parents[e.nodeId] !== p);
    const k = staying.length + incoming.length;
    const list: (string | null)[] = new Array(k).fill(null);
    for (const e of targets) list[e.position] = e.nodeId;
    const unspecified = staying.filter((c) => !editByNode.has(c));
    let cursor = 0;
    for (const c of unspecified) {
      while (list[cursor] !== null) cursor++;
      list[cursor] = c;
    }
    result[p] = list as string[];
  }
  return result;
}

const tree: InitNode = {
  id: 'R',
  children: [
    { id: 'a' },
    { id: 'b' },
    { id: 'c' },
    { id: 'd', children: [{ id: 'x' }, { id: 'y' }] },
    { id: 'e' },
  ],
};

test('多孩子换父与重排：结果与独立参考计算一致', () => {
  const service = new MindMapService(':memory:');
  service.initMap('m', tree);
  const before = service.readMap('m');
  const edits: EditOp[] = [
    { nodeId: 'x', newParentId: 'R', position: 0 },
    { nodeId: 'y', newParentId: 'R', position: 4 },
    { nodeId: 'b', newParentId: 'd', position: 0 },
    { nodeId: 'c', newParentId: 'R', position: 2 },
  ];
  const expected = referenceChildren(before, edits);
  const result = service.submitBatch('m', 1, edits);
  assert.deepEqual(result, { ok: true, version: 2 });
  const after = service.readMap('m');
  for (const [parentId, kids] of Object.entries(expected)) {
    assert.deepEqual(after.children[parentId], kids, `parent ${parentId}`);
  }
  // 未受影响的节点保持原样
  assert.deepEqual(after.children['a'], before.children['a']);
  assert.equal(after.parents['e'], 'R');
  service.close();
});

test('同父重排：指定位置必须生效', () => {
  const service = new MindMapService(':memory:');
  service.initMap('m', tree);
  const result = service.submitBatch('m', 1, [
    { nodeId: 'e', newParentId: 'R', position: 0 },
    { nodeId: 'a', newParentId: 'R', position: 4 },
  ]);
  assert.deepEqual(result, { ok: true, version: 2 });
  const snap = service.readMap('m');
  assert.deepEqual(snap.children['R'], ['e', 'b', 'c', 'd', 'a']);
  service.close();
});

function expectFailureKeepsMap(
  service: MindMapService,
  mapId: string,
  edits: EditOp[],
  reason: string,
): void {
  const before = service.readMap(mapId);
  const result = service.submitBatch(mapId, before.version, edits);
  assert.deepEqual(result, { ok: false, reason });
  const after = service.readMap(mapId);
  assert.deepEqual(after, before, '失败后导图与版本必须保持原样');
}

test('重复最终位置：整批失败且导图不变', () => {
  const service = new MindMapService(':memory:');
  service.initMap('m', tree);
  expectFailureKeepsMap(
    service,
    'm',
    [
      { nodeId: 'x', newParentId: 'R', position: 1 },
      { nodeId: 'y', newParentId: 'R', position: 1 },
    ],
    'duplicate_position',
  );
  service.close();
});

test('位置越界：整批失败且导图不变', () => {
  const service = new MindMapService(':memory:');
  service.initMap('m', tree);
  // x 搬入 d 后 d 有 3 个孩子，位置 3 越界
  expectFailureKeepsMap(
    service,
    'm',
    [{ nodeId: 'a', newParentId: 'd', position: 3 }],
    'position_out_of_range',
  );
  service.close();
});

test('最终成环：整批失败且导图不变', () => {
  const service = new MindMapService(':memory:');
  service.initMap('m', tree);
  // 互换成环：d 搬到 x 下（x 是 d 的后代）
  expectFailureKeepsMap(
    service,
    'm',
    [{ nodeId: 'd', newParentId: 'x', position: 0 }],
    'cycle',
  );
  // 两个节点互为新父节点：最终成环
  expectFailureKeepsMap(
    service,
    'm',
    [
      { nodeId: 'd', newParentId: 'x', position: 0 },
      { nodeId: 'x', newParentId: 'd', position: 0 },
    ],
    'cycle',
  );
  // 但 x 同批搬出 d 的子树后，d 再挂到 x 下是合法的
  const ok = service.submitBatch('m', 1, [
    { nodeId: 'd', newParentId: 'x', position: 0 },
    { nodeId: 'x', newParentId: 'R', position: 0 },
  ]);
  assert.deepEqual(ok, { ok: true, version: 2 });
  const snap = service.readMap('m');
  assert.equal(snap.parents['x'], 'R');
  assert.equal(snap.parents['d'], 'x');
  service.close();
});

test('搬迁后最深后代进入第13层：整批失败且导图不变', () => {
  const service = new MindMapService(':memory:');
  // 构造 12 层链 R-L2-...-L12，另有一支 P 带子节点 Q
  let deep: InitNode = { id: 'L12' };
  for (let i = 11; i >= 2; i--) {
    deep = { id: `L${i}`, children: [deep] };
  }
  const root: InitNode = {
    id: 'R',
    children: [deep, { id: 'P', children: [{ id: 'Q' }] }],
  };
  service.initMap('m', root);
  // P 搬到 L11 下：P 在第 12 层合法，但 Q 会到第 13 层
  expectFailureKeepsMap(
    service,
    'm',
    [{ nodeId: 'P', newParentId: 'L11', position: 0 }],
    'max_depth_exceeded',
  );
  // Q 单独搬到 L12 下：直接到第 13 层
  expectFailureKeepsMap(
    service,
    'm',
    [{ nodeId: 'Q', newParentId: 'L12', position: 0 }],
    'max_depth_exceeded',
  );
  // P 搬到 L10 下：P 第 11 层、Q 第 12 层，合法
  const ok = service.submitBatch('m', 1, [
    { nodeId: 'P', newParentId: 'L10', position: 0 },
  ]);
  assert.deepEqual(ok, { ok: true, version: 2 });
  service.close();
});

test('根不可搬动；不存在的节点或父节点被拒绝', () => {
  const service = new MindMapService(':memory:');
  service.initMap('m', tree);
  expectFailureKeepsMap(
    service,
    'm',
    [{ nodeId: 'R', newParentId: 'a', position: 0 }],
    'cannot_move_root',
  );
  expectFailureKeepsMap(
    service,
    'm',
    [{ nodeId: 'ghost', newParentId: 'R', position: 0 }],
    'node_not_found',
  );
  expectFailureKeepsMap(
    service,
    'm',
    [{ nodeId: 'a', newParentId: 'ghost', position: 0 }],
    'parent_not_found',
  );
  service.close();
});

test('每批最多 50 个不同节点', () => {
  const service = new MindMapService(':memory:');
  const many: InitNode = {
    id: 'R',
    children: Array.from({ length: 60 }, (_, i) => ({ id: `n${i}` })),
  };
  service.initMap('m', many);
  const edits: EditOp[] = Array.from({ length: 51 }, (_, i) => ({
    nodeId: `n${i}`,
    newParentId: 'n59',
    position: i,
  }));
  expectFailureKeepsMap(service, 'm', edits, 'too_many_edits');
  service.close();
});
