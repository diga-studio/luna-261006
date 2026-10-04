import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BatchValidationError,
  MapAlreadyExistsError,
  MapNotFoundError,
  MindMapLibrary,
  VersionConflictError,
} from '../src/index.js';
import type { MindMapNodeInput, MindMapNodeView } from '../src/index.js';

function tempDb(): string {
  return join(mkdtempSync(join(tmpdir(), 'mindmap-')), 'test.db');
}

function nested(id: string, ...children: MindMapNodeInput[]): MindMapNodeInput {
  return { id, children };
}

function shape(view: MindMapNodeView): string {
  if (view.children.length === 0) return view.id;
  return `${view.id}(${view.children.map(shape).join(',')})`;
}

test('初始化、读取与版本', async () => {
  const lib = new MindMapLibrary(tempDb());
  const init = await lib.initMap('m1', nested('R', nested('a'), nested('b')));
  assert.equal(init.version, 1);
  const snap = await lib.getMap('m1');
  assert.equal(snap.version, 1);
  assert.equal(shape(snap.root), 'R(a,b)');
  await assert.rejects(() => lib.getMap('ghost'), MapNotFoundError);
  await assert.rejects(() => lib.initMap('m1', nested('R2')), MapAlreadyExistsError);
  await lib.close();
});

test('提交成功版本恰好 +1，失败整批不留痕', async () => {
  const lib = new MindMapLibrary(tempDb());
  await lib.initMap('m1', nested('R', nested('a'), nested('b'), nested('c')));

  const committed = await lib.submitBatch('m1', {
    baseVersion: 1,
    edits: [{ nodeId: 'c', newParentId: 'R', position: 0 }],
  });
  assert.equal(committed.version, 2);
  assert.equal(shape((await lib.getMap('m1')).root), 'R(c,a,b)');

  // 过期版本整批拒绝，导图与版本不变。
  await assert.rejects(
    () =>
      lib.submitBatch('m1', {
        baseVersion: 1,
        edits: [{ nodeId: 'b', newParentId: 'R', position: 0 }],
      }),
    VersionConflictError,
  );
  // 非法编辑整批拒绝，导图与版本不变。
  await assert.rejects(
    () =>
      lib.submitBatch('m1', {
        baseVersion: 2,
        edits: [{ nodeId: 'a', newParentId: 'b', position: 5 }],
      }),
    BatchValidationError,
  );
  const snap = await lib.getMap('m1');
  assert.equal(snap.version, 2);
  assert.equal(shape(snap.root), 'R(c,a,b)');
  await lib.close();
});

test('验收场景：R/A/B/C 嵌套，同批搬 C 与 A，排列无关', async () => {
  for (const order of [0, 1] as const) {
    const lib = new MindMapLibrary(tempDb());
    await lib.initMap('m', nested('R', nested('A', nested('B', nested('C')))));
    const edits = [
      { nodeId: 'C', newParentId: 'R', position: 0 },
      { nodeId: 'A', newParentId: 'C', position: 0 },
    ];
    if (order === 1) edits.reverse();
    const result = await lib.submitBatch('m', { baseVersion: 1, edits });
    assert.equal(result.version, 2);
    const snap = await lib.getMap('m');
    assert.equal(shape(snap.root), 'R(C(A(B)))');
    await lib.close();
  }
});

test('50 个同版本合法批次竞争：恰好一个成功，版本仅 +1', async () => {
  const lib = new MindMapLibrary(tempDb());
  const kids: MindMapNodeInput[] = Array.from({ length: 60 }, (_, index) => nested(`k${index}`));
  await lib.initMap('m', nested('R', ...kids));

  const results = await Promise.all(
    Array.from({ length: 50 }, (_, index) =>
      lib
        .submitBatch('m', {
          baseVersion: 1,
          edits: [{ nodeId: `k${index}`, newParentId: 'R', position: 0 }],
        })
        .then(
          (result) => ({ ok: true as const, result }),
          (error: unknown) => ({ ok: false as const, error }),
        ),
    ),
  );
  const succeeded = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  assert.equal(succeeded.length, 1);
  assert.equal(failed.length, 49);
  for (const failure of failed) {
    assert.ok(failure.ok === false && failure.error instanceof VersionConflictError);
  }
  const snap = await lib.getMap('m');
  assert.equal(snap.version, 2);
  // 完整结果可见：恰好一个节点被搬到首位，其余保持原相对顺序。
  assert.equal(snap.root.children.length, 60);
  const winner = snap.root.children[0]!.id;
  const rest = snap.root.children.slice(1).map((c) => c.id);
  assert.deepEqual(
    rest,
    Array.from({ length: 60 }, (_, index) => `k${index}`).filter((id) => id !== winner),
  );
  await lib.close();
});

test('关闭后重开：已提交状态与版本完整恢复', async () => {
  const dbPath = tempDb();
  const lib = new MindMapLibrary(dbPath);
  await lib.initMap('m', nested('R', nested('a'), nested('b')));
  await lib.submitBatch('m', {
    baseVersion: 1,
    edits: [{ nodeId: 'b', newParentId: 'a', position: 0 }],
  });
  await lib.close();

  const reopened = new MindMapLibrary(dbPath);
  const snap = await reopened.getMap('m');
  assert.equal(snap.version, 2);
  assert.equal(shape(snap.root), 'R(a(b))');
  // 重开后可继续提交。
  const result = await reopened.submitBatch('m', {
    baseVersion: 2,
    edits: [{ nodeId: 'b', newParentId: 'R', position: 1 }],
  });
  assert.equal(result.version, 3);
  assert.equal(shape((await reopened.getMap('m')).root), 'R(a,b)');
  await reopened.close();
  rmSync(dbPath, { force: true });
});
