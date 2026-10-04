import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { MigrationKernel } from '../src/kernel';

const pools = [{ poolId: 'web', cpu: 2, memory: 4 }];

function newKernel(): MigrationKernel {
  return new MigrationKernel(
    [
      { hostId: 'h1', cpu: 4, memory: 8 },
      { hostId: 'h2', cpu: 4, memory: 8 },
    ],
    pools,
  );
}

test('admit 在在线主机创建会话并占用容量', () => {
  const k = newKernel();
  const s1 = k.admit('web', 'h1');
  assert.ok(s1);
  const snap = k.snapshot();
  assert.equal(snap.sessions.get(s1!)?.hostId, 'h1');
  assert.deepEqual(snap.hosts.get('h1')?.used, { cpu: 2, memory: 4 });
});

test('admit 容量不足时拒绝', () => {
  const k = newKernel();
  assert.ok(k.admit('web', 'h1'));
  assert.ok(k.admit('web', 'h1'));
  assert.equal(k.admit('web', 'h1'), null);
});

test('admit 未知池或未知主机返回 null', () => {
  const k = newKernel();
  assert.equal(k.admit('nope', 'h1'), null);
  assert.equal(k.admit('web', 'nope'), null);
});

test('close 幂等且释放占用', () => {
  const k = newKernel();
  const s1 = k.admit('web', 'h1')!;
  k.close(s1);
  k.close(s1);
  k.close('ghost');
  const snap = k.snapshot();
  assert.equal(snap.sessions.size, 0);
  assert.deepEqual(snap.hosts.get('h1')?.used, { cpu: 0, memory: 0 });
});

test('drain 空主机直接进维护中；非空主机受阻可重试', () => {
  const k = newKernel();
  assert.equal(k.drain('h2'), 'success');
  assert.equal(k.snapshot().hosts.get('h2')?.state, 'maintenance');
  // 已在维护中：直接成功
  assert.equal(k.drain('h2'), 'success');

  const s1 = k.admit('web', 'h1')!;
  assert.equal(k.drain('h1'), 'blocked');
  assert.equal(k.snapshot().hosts.get('h1')?.state, 'draining');
  // 迁出中禁止新建
  assert.equal(k.admit('web', 'h1'), null);
  k.close(s1);
  assert.equal(k.drain('h1'), 'success');
  assert.equal(k.snapshot().hosts.get('h1')?.state, 'maintenance');
});

test('维护中主机不保有会话与预占', () => {
  const k = newKernel();
  const s1 = k.admit('web', 'h1')!;
  k.drain('h1');
  k.close(s1);
  k.drain('h1');
  const snap = k.snapshot();
  const h1 = snap.hosts.get('h1')!;
  assert.equal(h1.state, 'maintenance');
  assert.equal(h1.sessions.length, 0);
  assert.deepEqual(h1.reserved, { cpu: 0, memory: 0 });
  assert.equal(snap.reservations.size, 0);
});
