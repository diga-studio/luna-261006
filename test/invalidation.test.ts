import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { MigrationKernel } from '../src/kernel';

const pools = [{ poolId: 'web', cpu: 2, memory: 4 }];

function twoHosts(): MigrationKernel {
  return new MigrationKernel(
    [
      { hostId: 'h1', cpu: 4, memory: 8 },
      { hostId: 'h2', cpu: 4, memory: 8 },
    ],
    pools,
  );
}

test('准备挂起时关闭源会话：成功回报送达后无复活、无迁入、无残留预占', async () => {
  const k = twoHosts();
  const s1 = k.admit('web', 'h1')!;
  const p1 = k.prepareMigration('a1', s1, 'h1', 'h2');

  // 挂起期间：预占可见，会话仍属源主机。
  let snap = k.snapshot();
  assert.equal(snap.reservations.size, 1);
  assert.equal(snap.sessions.get(s1)?.hostId, 'h1');

  // 关闭源会话：立即作废准备并释放目标预占与源占用。
  k.close(s1);
  snap = k.snapshot();
  assert.equal(snap.reservations.size, 0, '关闭立即释放目标预占');
  assert.deepEqual(snap.hosts.get('h2')?.reserved, { cpu: 0, memory: 0 });
  assert.deepEqual(snap.hosts.get('h1')?.used, { cpu: 0, memory: 0 }, '关闭释放源占用');

  // 之后送达的成功回报不得提交。
  assert.equal(await p1, false);
  snap = k.snapshot();
  assert.equal(snap.sessions.size, 0, '会话不得复活');
  assert.equal(snap.hosts.get('h2')?.sessions.length, 0, '不得非法迁入');
  assert.equal(snap.reservations.size, 0, '不得残留预占');
});

test('准备挂起时目标进入维护：成功回报送达后归属不变、无残留预占', async () => {
  const k = twoHosts();
  const s1 = k.admit('web', 'h1')!;
  const p1 = k.prepareMigration('a1', s1, 'h1', 'h2');

  let snap = k.snapshot();
  assert.equal(snap.reservations.get('a1')?.toHost, 'h2');

  // 目标开始维护：立即作废准备并释放预占；h2 无会话，直接进维护中。
  assert.equal(k.drain('h2'), 'success');
  snap = k.snapshot();
  assert.equal(snap.hosts.get('h2')?.state, 'maintenance');
  assert.equal(snap.reservations.size, 0, '目标维护立即释放预占');
  assert.equal(snap.sessions.get(s1)?.hostId, 'h1', '目标维护不改变源归属');

  // 之后送达的成功回报不得提交。
  assert.equal(await p1, false);
  snap = k.snapshot();
  assert.equal(snap.sessions.get(s1)?.hostId, 'h1', '归属与维护状态一致');
  assert.equal(snap.hosts.get('h2')?.sessions.length, 0, '维护中主机不得保有会话');
  assert.equal(snap.hosts.get('h2')?.reserved.cpu, 0, '维护中主机不得保有预占');
  assert.equal(snap.reservations.size, 0);

  // 维护中的目标不再接受迁入。
  assert.equal(await k.prepareMigration('a2', s1, 'h1', 'h2'), false);
  assert.equal(k.snapshot().reservations.size, 0);
});

test('迁出中主机禁止新建与迁入，但已挂起的迁出准备可提交', async () => {
  const k = twoHosts();
  const s1 = k.admit('web', 'h1')!;
  const p1 = k.prepareMigration('a1', s1, 'h1', 'h2');
  assert.equal(k.drain('h1'), 'blocked');
  assert.equal(k.admit('web', 'h1'), null, '迁出中禁止新建');
  assert.equal(await k.prepareMigration('a2', s1, 'h2', 'h1'), false, '迁出中禁止迁入');
  assert.equal(await p1, true, '源主机迁出中不影响其迁出准备提交');
  assert.equal(k.drain('h1'), 'success', '会话迁出后重试 drain 成功');
  assert.equal(k.snapshot().hosts.get('h1')?.state, 'maintenance');
});
