import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { MigrationKernel } from '../src/kernel';

const pools = [{ poolId: 'web', cpu: 2, memory: 4 }];

test('同一源主机两个准备：一成功一失败；重试后成功的不回滚、失败的可再迁', async () => {
  const k = new MigrationKernel(
    [
      { hostId: 'h1', cpu: 8, memory: 16 },
      { hostId: 'h2', cpu: 2, memory: 4 }, // 恰好只容得下一个会话
      { hostId: 'h3', cpu: 4, memory: 8 },
    ],
    pools,
  );
  const s1 = k.admit('web', 'h1')!;
  const s2 = k.admit('web', 'h1')!;

  // 两个准备指向同一目标 h2：第一个占满容量，第二个失败且不留预占。
  const p1 = k.prepareMigration('a1', s1, 'h1', 'h2');
  const p2 = k.prepareMigration('a2', s2, 'h1', 'h2');

  assert.equal(await p2, false);
  let snap = k.snapshot();
  assert.equal(snap.reservations.size, 1, '失败准备不得留下失效预占');
  assert.equal(snap.reservations.has('a2'), false);
  assert.equal(snap.sessions.get(s2)?.hostId, 'h1', '失败不改变源归属');

  assert.equal(await p1, true);
  snap = k.snapshot();
  assert.equal(snap.sessions.get(s1)?.hostId, 'h2', '成功准备提交归属交接');
  assert.equal(snap.reservations.size, 0, '提交后预占释放');
  assert.deepEqual(snap.hosts.get('h2')?.used, { cpu: 2, memory: 4 });

  // 后续重试：失败会话迁往 h3。
  const p3 = k.prepareMigration('a3', s2, 'h1', 'h3');
  assert.equal(await p3, true);
  snap = k.snapshot();
  assert.equal(snap.sessions.get(s2)?.hostId, 'h3', '失败会话可继续迁出');
  assert.equal(snap.sessions.get(s1)?.hostId, 'h2', '已迁出会话不回滚');
  assert.equal(snap.hosts.get('h1')?.sessions.length, 0);
});

test('准备挂起期间快照可见预占，会话仍属源主机', async () => {
  const k = new MigrationKernel(
    [
      { hostId: 'h1', cpu: 4, memory: 8 },
      { hostId: 'h2', cpu: 4, memory: 8 },
    ],
    pools,
  );
  const s1 = k.admit('web', 'h1')!;
  const p1 = k.prepareMigration('a1', s1, 'h1', 'h2');

  const snap = k.snapshot();
  assert.equal(snap.sessions.get(s1)?.hostId, 'h1');
  assert.deepEqual(snap.hosts.get('h1')?.used, { cpu: 2, memory: 4 });
  assert.deepEqual(snap.hosts.get('h2')?.reserved, { cpu: 2, memory: 4 });
  assert.equal(snap.reservations.get('a1')?.toHost, 'h2');
  // 预占生效期间目标容量被保护：剩余容量仅够一个会话。
  assert.ok(k.admit('web', 'h2'));
  assert.equal(k.admit('web', 'h2'), null);

  assert.equal(await p1, true);
});

test('异常输入也算失败且不产生副作用', async () => {
  const k = new MigrationKernel([{ hostId: 'h1', cpu: 4, memory: 8 }], pools);
  const s1 = k.admit('web', 'h1')!;
  assert.equal(await k.prepareMigration('a1', 'ghost', 'h1', 'h2'), false);
  assert.equal(await k.prepareMigration('a2', s1, 'h2', 'h1'), false);
  assert.equal(await k.prepareMigration('a3', s1, 'h1', 'h1'), false);
  assert.equal(await k.prepareMigration('a4', s1, 'h1', 'ghost'), false);
  const snap = k.snapshot();
  assert.equal(snap.reservations.size, 0);
  assert.equal(snap.sessions.get(s1)?.hostId, 'h1');
});
