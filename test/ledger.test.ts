import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Ledger,
  ManualClock,
  CancelWindowExpiredError,
  InsufficientFundsError,
  RedemptionNotFoundError,
  type Snapshot,
} from '../src/index.ts';

const HOUR = 60 * 60 * 1000;

function makeLedger(clock: ManualClock): { ledger: Ledger; dbPath: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-test-'));
  const dbPath = join(dir, 'ledger.db');
  return { ledger: new Ledger(dbPath, { clock }), dbPath, dir };
}

/** 校验题目要求的不变量。 */
function assertInvariant(snap: Snapshot): void {
  let total = 0;
  for (const b of snap.batches) {
    assert.equal(
      b.allocated,
      b.available + b.spent + b.expired,
      `batch ${b.month}: allocated = available + spent + expired`,
    );
    for (const v of [b.available, b.spent, b.expired]) {
      assert.ok(v >= 0, `batch ${b.month}: non-negative`);
    }
    total += b.available;
  }
  assert.equal(snap.totalAvailable, total, 'totalAvailable = sum of available');
}

test('交叉消耗两个批次，较早批次到期前后分别取消', () => {
  const clock = new ManualClock(Date.UTC(2026, 0, 10));
  const { ledger } = makeLedger(clock);
  const emp = 'e1';

  // 三个批次：1月 1000、2月 1000、3月 500
  ledger.credit(emp, 1000, 'c-jan');
  clock.set(Date.UTC(2026, 1, 3));
  ledger.credit(emp, 1000, 'c-feb');
  clock.set(Date.UTC(2026, 2, 4));
  ledger.credit(emp, 500, 'c-mar');

  // r1 跨 1月+2月；在较早批次（1月）到期前取消
  clock.set(Date.UTC(2026, 2, 10, 10));
  const r1 = ledger.redeem(emp, 1500, 'r1');
  assert.deepEqual(r1.shares, [
    { month: '2026-01', cents: 1000 },
    { month: '2026-02', cents: 500 },
  ]);

  clock.advance(2 * HOUR);
  const c1 = ledger.cancel(emp, r1.redemptionId, 'x1');
  assert.deepEqual(c1.refunds, [
    { month: '2026-01', cents: 1000, reusable: true },
    { month: '2026-02', cents: 500, reusable: true },
  ]);
  let snap = ledger.snapshot(emp);
  assert.equal(snap.totalAvailable, 2500);
  assertInvariant(snap);

  // r2 再次跨 1月+2月；r3 只消耗 2月（保持未取消，用于验证归属不变）
  clock.set(Date.UTC(2026, 3, 30, 12));
  const r2 = ledger.redeem(emp, 1200, 'r2');
  assert.deepEqual(r2.shares, [
    { month: '2026-01', cents: 1000 },
    { month: '2026-02', cents: 200 },
  ]);
  clock.advance(1 * HOUR);
  const r3 = ledger.redeem(emp, 300, 'r3');
  assert.deepEqual(r3.shares, [{ month: '2026-02', cents: 300 }]);

  // 恰好到 1月批次到期时刻（2026-05-01T00:00:00Z，不含该时刻）
  clock.set(Date.UTC(2026, 4, 1));
  snap = ledger.snapshot(emp);
  const jan = snap.batches.find((b) => b.month === '2026-01')!;
  assert.deepEqual(
    { allocated: jan.allocated, available: jan.available, spent: jan.spent, expired: jan.expired },
    { allocated: 1000, available: 0, spent: 1000, expired: 0 },
  );
  assert.equal(snap.totalAvailable, 1000); // 2月 500 + 3月 500
  assertInvariant(snap);

  // 1月批次到期后取消 r2（距 r2 创建 22 小时，在取消期限内）
  clock.set(Date.UTC(2026, 4, 1, 10));
  const c2 = ledger.cancel(emp, r2.redemptionId, 'x2');
  assert.deepEqual(c2.refunds, [
    { month: '2026-01', cents: 1000, reusable: false }, // 已到期，计入 expired
    { month: '2026-02', cents: 200, reusable: true },
  ]);

  snap = ledger.snapshot(emp);
  const jan2 = snap.batches.find((b) => b.month === '2026-01')!;
  assert.equal(jan2.expired, 1000); // 过期退款计入 expired
  assert.equal(jan2.available, 0);
  const feb2 = snap.batches.find((b) => b.month === '2026-02')!;
  // 未取消的 r3 归属不变：2月 spent 恰好是 r3 的 300
  assert.equal(feb2.spent, 300);
  assert.equal(feb2.available, 700);
  assert.equal(snap.totalAvailable, 1200); // 2月 700 + 3月 500
  assertInvariant(snap);

  // 过期退款不可再次消费：1201 超出可用总额
  assert.throws(() => ledger.redeem(emp, 1201, 'r-over'), InsufficientFundsError);

  // 未过期退款仍按到期顺序消费：先用完 2月（含退款的 200），再用 3月
  const r4 = ledger.redeem(emp, 800, 'r4');
  assert.deepEqual(r4.shares, [
    { month: '2026-02', cents: 700 },
    { month: '2026-03', cents: 100 },
  ]);
  snap = ledger.snapshot(emp);
  assert.equal(snap.totalAvailable, 400);
  assertInvariant(snap);

  ledger.close();
});

test('取消期限与去重窗口边界，关闭重开后重放', () => {
  const t0 = Date.UTC(2026, 0, 15);
  const clock = new ManualClock(t0);
  const { ledger, dbPath } = makeLedger(clock);
  const emp = 'e2';

  ledger.credit(emp, 1000, 'k-c');
  const r1 = ledger.redeem(emp, 400, 'k-r1');
  const r2 = ledger.redeem(emp, 300, 'k-r2');

  // 取消期限边界：24h 差 1ms 可以取消
  clock.set(t0 + 24 * HOUR - 1);
  const cancelR2 = ledger.cancel(emp, r2.redemptionId, 'k-x');
  assert.equal(cancelR2.cancelledAtMs, t0 + 24 * HOUR - 1);

  // 恰好满 24 小时不允许首次取消
  clock.set(t0 + 24 * HOUR);
  assert.throws(() => ledger.cancel(emp, r1.redemptionId, 'k-x1'), CancelWindowExpiredError);
  let snap = ledger.snapshot(emp);
  assert.equal(snap.totalAvailable, 600); // 失败操作不留部分冲正
  assertInvariant(snap);

  // 正常关闭后重开，状态仍在
  ledger.close();
  const reopened = new Ledger(dbPath, { clock });

  // 重放成功取消（窗口内）：即使已超过 24 小时取消期限，也返回原结果而非失败
  const replayed = reopened.cancel(emp, r2.redemptionId, 'k-x');
  assert.deepEqual(replayed, cancelR2);

  // 换 key 再次取消：返回原取消结果，不再返钱
  const again = reopened.cancel(emp, r2.redemptionId, 'k-x-other');
  assert.deepEqual(again, cancelR2);
  snap = reopened.snapshot(emp);
  assert.equal(snap.totalAvailable, 600);

  // 再次发放同月额度（换 key）：返回原记录
  const dup = reopened.credit(emp, 500, 'k-c-2');
  assert.equal(dup.cents, 1000);
  assert.equal(dup.key, 'k-c');
  assert.equal(dup.createdAtMs, t0);
  assert.equal(dup.month, '2026-01');

  // 去重窗口边界（用 redeem 观察：重放返回原兑换 ID，新请求生成新 ID）
  const emp3 = 'e3';
  const s0 = t0 + 30 * HOUR;
  clock.set(s0);
  reopened.credit(emp3, 10000, 'kc3');
  const ra = reopened.redeem(emp3, 100, 'kr3');
  clock.set(s0 + 48 * HOUR - 1); // 窗口内：重放，且窗口不因重试延长
  assert.equal(reopened.redeem(emp3, 100, 'kr3').redemptionId, ra.redemptionId);
  clock.set(s0 + 48 * HOUR); // 恰好满 48 小时：按新请求处理
  const rb = reopened.redeem(emp3, 100, 'kr3');
  assert.notEqual(rb.redemptionId, ra.redemptionId);

  // 恰好满 48 小时后，取消的成功去重记录也按新请求处理：
  // 兑换已取消，走状态去重仍返回原结果，且不报错、不返钱
  clock.set(t0 + 24 * HOUR - 1 + 48 * HOUR);
  const afterWindow = reopened.cancel(emp, r2.redemptionId, 'k-x');
  assert.deepEqual(afterWindow, cancelR2);
  snap = reopened.snapshot(emp);
  assert.equal(snap.totalAvailable, 600);
  assertInvariant(snap);

  reopened.close();
});

test('到期精确边界与失败操作不留痕迹', () => {
  const clock = new ManualClock(Date.UTC(2026, 0, 20));
  const { ledger } = makeLedger(clock);

  // 到期边界：2026-01 发放，2026-05-01T00:00:00Z 到期（不含）
  ledger.credit('e4', 100, 'k');
  clock.set(Date.UTC(2026, 3, 30, 23, 59, 59) + 999);
  assert.equal(ledger.snapshot('e4').totalAvailable, 100);
  clock.set(Date.UTC(2026, 4, 1));
  const snap4 = ledger.snapshot('e4');
  assert.equal(snap4.totalAvailable, 0);
  assert.equal(snap4.batches[0]!.expired, 100);
  assert.throws(() => ledger.redeem('e4', 1, 'r'), InsufficientFundsError);
  assertInvariant(snap4);

  // 额度不足整体失败，不留部分扣款
  clock.set(Date.UTC(2026, 0, 25));
  ledger.credit('e5', 500, 'kc5');
  assert.throws(() => ledger.redeem('e5', 600, 'kf5'), InsufficientFundsError);
  const snap5 = ledger.snapshot('e5');
  assert.equal(snap5.totalAvailable, 500);
  assert.equal(snap5.batches[0]!.spent, 0);

  // 失败的去重记录不残留：状态改变后同 key 同参数按新请求成功处理
  ledger.credit('e6', 400, 'kc6');
  assert.throws(() => ledger.redeem('e6', 600, 'kf6'), InsufficientFundsError);
  clock.set(Date.UTC(2026, 1, 10));
  ledger.credit('e6', 400, 'kc6-feb');
  const ok = ledger.redeem('e6', 600, 'kf6');
  assert.deepEqual(ok.shares, [
    { month: '2026-01', cents: 400 },
    { month: '2026-02', cents: 200 },
  ]);

  // 取消不存在的兑换
  assert.throws(() => ledger.cancel('e6', 'no-such-id', 'kx'), RedemptionNotFoundError);

  // 超期取消失败，不留部分冲正
  const r = ledger.redeem('e6', 100, 'kr6');
  clock.set(Date.UTC(2026, 1, 10) + 24 * HOUR);
  assert.throws(() => ledger.cancel('e6', r.redemptionId, 'kx6'), CancelWindowExpiredError);
  const snap6 = ledger.snapshot('e6');
  assert.equal(snap6.batches.find((b) => b.month === '2026-02')!.spent, 300);
  assertInvariant(snap6);

  ledger.close();
});
