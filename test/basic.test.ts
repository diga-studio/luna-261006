import assert from 'node:assert/strict';
import test from 'node:test';
import { MindMapService, type InitNode } from '../src/mindmap.js';

function chain(...ids: string[]): InitNode {
  let node: InitNode = { id: ids[ids.length - 1] };
  for (let i = ids.length - 2; i >= 0; i--) {
    node = { id: ids[i], children: [node] };
  }
  return node;
}

/** 从根出发按“每次取第一个孩子”展开链式结构。 */
function firstChildChain(service: MindMapService, mapId: string): string[] {
  const snap = service.readMap(mapId);
  const result: string[] = [snap.rootId];
  let current = snap.rootId;
  while ((snap.children[current] ?? []).length > 0) {
    current = snap.children[current][0];
    result.push(current);
  }
  return result;
}

test('同批搬动祖先与后代：结果与操作排列无关', () => {
  const edits = [
    { nodeId: 'C', newParentId: 'R', position: 0 },
    { nodeId: 'A', newParentId: 'C', position: 0 },
  ];
  const orders = [edits, [...edits].reverse()];
  const snapshots: string[][] = [];
  for (const ordered of orders) {
    const service = new MindMapService(':memory:');
    service.initMap('m', chain('R', 'A', 'B', 'C'));
    const result = service.submitBatch('m', 1, ordered);
    assert.deepEqual(result, { ok: true, version: 2 });
    snapshots.push(firstChildChain(service, 'm'));
    service.close();
  }
  // R、C、A、B 依次嵌套，且两种排列结果一致
  assert.deepEqual(snapshots[0], ['R', 'C', 'A', 'B']);
  assert.deepEqual(snapshots[1], ['R', 'C', 'A', 'B']);
});

test('初始化后可读取版本与结构', () => {
  const service = new MindMapService(':memory:');
  const version = service.initMap('m', {
    id: 'R',
    children: [{ id: 'A' }, { id: 'B', children: [{ id: 'C' }] }],
  });
  assert.equal(version, 1);
  const snap = service.readMap('m');
  assert.equal(snap.version, 1);
  assert.equal(snap.rootId, 'R');
  assert.deepEqual(snap.children['R'], ['A', 'B']);
  assert.deepEqual(snap.children['B'], ['C']);
  assert.equal(snap.parents['C'], 'B');
  assert.equal(snap.parents['R'], null);
  service.close();
});

test('过期版本整批拒绝，导图保持不变', () => {
  const service = new MindMapService(':memory:');
  service.initMap('m', { id: 'R', children: [{ id: 'A' }, { id: 'B' }] });
  const ok = service.submitBatch('m', 1, [
    { nodeId: 'A', newParentId: 'B', position: 0 },
  ]);
  assert.deepEqual(ok, { ok: true, version: 2 });
  const stale = service.submitBatch('m', 1, [
    { nodeId: 'B', newParentId: 'A', position: 0 },
  ]);
  assert.deepEqual(stale, { ok: false, reason: 'version_conflict' });
  const snap = service.readMap('m');
  assert.equal(snap.version, 2);
  assert.deepEqual(snap.children['R'], ['B']);
  assert.deepEqual(snap.children['B'], ['A']);
  service.close();
});
