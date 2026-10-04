import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MindMapService, type EditOp, type InitNode } from '../src/mindmap.js';

function wideTree(fanout: number): InitNode {
  return {
    id: 'R',
    children: Array.from({ length: fanout }, (_, i) => ({ id: `n${i}` })),
  };
}

/** 第 i 个竞争批次：把 ni 搬到 n0 下的第 0 位（各自合法）。 */
function competingEdit(i: number): EditOp[] {
  return [{ nodeId: `n${i}`, newParentId: 'n0', position: 0 }];
}

test('50 个同版本合法批次竞争：恰好一个成功，版本仅 +1', async () => {
  const service = new MindMapService(':memory:');
  service.initMap('m', wideTree(60));
  const results = await Promise.all(
    Array.from({ length: 50 }, (_, i) =>
      Promise.resolve().then(() => service.submitBatch('m', 1, competingEdit(i + 1))),
    ),
  );
  const succeeded = results.filter((r) => r.ok);
  const conflicts = results.filter(
    (r) => !r.ok && r.reason === 'version_conflict',
  );
  assert.equal(succeeded.length, 1, '必须恰好一个成功');
  assert.equal(conflicts.length, 49, '其余全部版本冲突');
  assert.deepEqual(succeeded[0], { ok: true, version: 2 });
  const snap = service.readMap('m');
  assert.equal(snap.version, 2, '版本仅增加 1');
  // 只有一个节点被搬到 n0 下
  assert.equal(snap.children['n0'].length, 1);
  assert.equal(snap.children['R'].length, 59);
  service.close();
});

test('多实例共享同一 SQLite 文件：竞争提交仍恰好一个成功', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mindmap-'));
  try {
    const dbPath = join(dir, 'shared.db');
    const writer = new MindMapService(dbPath);
    writer.initMap('m', wideTree(60));
    writer.close();

    const instances = Array.from(
      { length: 50 },
      () => new MindMapService(dbPath),
    );
    const results = instances.map((svc, i) =>
      svc.submitBatch('m', 1, competingEdit(i + 1)),
    );
    const succeeded = results.filter((r) => r.ok);
    assert.equal(succeeded.length, 1);
    assert.equal(
      results.filter((r) => !r.ok && r.reason === 'version_conflict').length,
      49,
    );

    // 用全新实例验证：只有一个批次的完整结果可见，版本为 2
    const verifier = new MindMapService(dbPath);
    const snap = verifier.readMap('m');
    assert.equal(snap.version, 2);
    assert.equal(snap.children['n0'].length, 1);
    assert.equal(snap.children['R'].length, 59);
    verifier.close();
    for (const svc of instances) {
      svc.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('失败批次不留任何修改', () => {
  const service = new MindMapService(':memory:');
  service.initMap('m', wideTree(10));
  const before = service.readMap('m');
  // 批内前 49 项合法、最后 1 项位置越界：整批必须回滚
  const edits: EditOp[] = Array.from({ length: 49 }, (_, i) => ({
    nodeId: `n${i}`,
    newParentId: 'n9',
    position: i,
  }));
  edits.push({ nodeId: 'n9', newParentId: 'n0', position: 99 });
  const result = service.submitBatch('m', 1, edits);
  assert.equal(result.ok, false);
  assert.deepEqual(service.readMap('m'), before);
  service.close();
});
