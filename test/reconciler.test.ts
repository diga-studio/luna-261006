import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Reconciler } from '../src/reconciler';
import { ReviewReport, Snapshot } from '../src/types';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 收集 review 调用并允许测试手动决定结果 */
function reviewGate() {
  const calls: ReviewReport[] = [];
  const gates: Deferred<boolean>[] = [];
  const review = (report: ReviewReport): Promise<boolean> => {
    calls.push(report);
    const gate = deferred<boolean>();
    gates.push(gate);
    return gate.promise;
  };
  return { calls, gates, review };
}

test('同一PO行拆行合并后计算价差：单行不超阈值，合并后超阈值触发复核', async () => {
  const rec = new Reconciler([{ poLineId: 'A', unitPriceCents: 10000 }]);
  rec.setReceipt('R1', 'A', 10);
  const gate = reviewGate();
  // 每行 diff=3000 < 5000；合并后 expected=20000, actual=26000, diff=6000 > max(5000, 1000)
  const resultPromise = rec.reconcile(
    'INV-1',
    [
      { poLineId: 'A', quantity: 1, amountCents: 13000 },
      { poLineId: 'A', quantity: 1, amountCents: 13000 },
    ],
    gate.review,
  );
  assert.equal(gate.calls.length, 1, '合并后价差超阈值，整单只复核一次');
  const report = gate.calls[0]!;
  assert.equal(report.invoiceId, 'INV-1');
  assert.equal(report.lines.length, 1, '同一PO行的条目必须合并');
  assert.deepEqual(report.lines[0], {
    poLineId: 'A',
    quantity: 2,
    expectedCents: 20000,
    actualCents: 26000,
    diffCents: 6000,
    thresholdCents: 5000,
    flagged: true,
  });
  gate.gates[0]!.resolve(true);
  assert.deepEqual(await resultPromise, { status: 'authorized' });
  const snap = rec.snapshot();
  assert.equal(snap.receipts[0]!.authorizedQty, 2);
  assert.equal(snap.receipts[0]!.heldQty, 0);
});

test('价差恰好等于阈值（绝对值与5%两种）时不触发复核，直接授权', async () => {
  const rec = new Reconciler([
    { poLineId: 'A', unitPriceCents: 100 },
    { poLineId: 'B', unitPriceCents: 200000 },
  ]);
  rec.setReceipt('R1', 'A', 1);
  rec.setReceipt('R2', 'B', 2);
  const gate = reviewGate();
  // diff = 5000，恰等于绝对阈值 max(5000, 5) → 不触发
  const r1 = await rec.reconcile('INV-1', [{ poLineId: 'A', quantity: 1, amountCents: 5100 }], gate.review);
  // diff = 10000，恰等于5%阈值 max(5000, 10000) → 不触发
  const r2 = await rec.reconcile('INV-2', [{ poLineId: 'B', quantity: 1, amountCents: 210000 }], gate.review);
  assert.deepEqual(r1, { status: 'authorized' });
  assert.deepEqual(r2, { status: 'authorized' });
  assert.equal(gate.calls.length, 0, '等于阈值不触发复核');
  // diff = 10001，严格大于 max(5000, 10000) → 触发
  const p3 = rec.reconcile('INV-3', [{ poLineId: 'B', quantity: 1, amountCents: 210001 }], gate.review);
  assert.equal(gate.calls.length, 1);
  gate.gates[0]!.resolve(true);
  assert.deepEqual(await p3, { status: 'authorized' });
});

test('数量不足整单失败且不调用review；补足后可重试成功', async () => {
  const rec = new Reconciler([{ poLineId: 'A', unitPriceCents: 100 }]);
  rec.setReceipt('R1', 'A', 2);
  const gate = reviewGate();
  const failed = await rec.reconcile('INV-1', [{ poLineId: 'A', quantity: 3, amountCents: 300 }], gate.review);
  assert.equal(failed.status, 'failed');
  assert.equal(gate.calls.length, 0, '数量不足不得调用review');
  assert.equal(rec.snapshot().receipts[0]!.heldQty, 0, '失败不得留下预占');
  rec.setReceipt('R1', 'A', 3);
  const ok = await rec.reconcile('INV-1', [{ poLineId: 'A', quantity: 3, amountCents: 300 }], gate.review);
  assert.deepEqual(ok, { status: 'authorized' });
});

test('review拒绝则整单释放并允许重试；review抛错同样释放', async () => {
  const rec = new Reconciler([{ poLineId: 'A', unitPriceCents: 100 }]);
  rec.setReceipt('R1', 'A', 5);
  const gate = reviewGate();
  const lines = [{ poLineId: 'A', quantity: 2, amountCents: 9999 }];
  const p1 = rec.reconcile('INV-1', lines, gate.review);
  assert.equal(rec.snapshot().receipts[0]!.heldQty, 2, '复核期间整单预占');
  gate.gates[0]!.resolve(false);
  assert.deepEqual(await p1, { status: 'rejected' });
  assert.equal(rec.snapshot().receipts[0]!.heldQty, 0, '拒绝后释放预占');

  const p2 = rec.reconcile('INV-1', lines, gate.review);
  gate.gates[1]!.reject(new Error('review service down'));
  assert.deepEqual(await p2, { status: 'rejected' });
  assert.equal(rec.snapshot().receipts[0]!.heldQty, 0, '抛错后释放预占');

  const p3 = rec.reconcile('INV-1', lines, gate.review);
  gate.gates[2]!.resolve(true);
  assert.deepEqual(await p3, { status: 'authorized' });
  assert.equal(rec.snapshot().receipts[0]!.authorizedQty, 2);
});

test('同一invoiceId内容固定；已授权发票不得重复占用或重复授权', async () => {
  const rec = new Reconciler([{ poLineId: 'A', unitPriceCents: 100 }]);
  rec.setReceipt('R1', 'A', 5);
  const gate = reviewGate();
  const lines = [{ poLineId: 'A', quantity: 2, amountCents: 200 }];
  assert.deepEqual(await rec.reconcile('INV-1', lines, gate.review), { status: 'authorized' });
  const again = await rec.reconcile('INV-1', lines, gate.review);
  assert.deepEqual(again, { status: 'authorized' });
  assert.equal(rec.snapshot().receipts[0]!.authorizedQty, 2, '不得重复授权');
  assert.equal(rec.snapshot().receipts[0]!.heldQty, 0, '不得重复占用');
  await assert.rejects(
    rec.reconcile('INV-1', [{ poLineId: 'A', quantity: 3, amountCents: 300 }], gate.review),
    /immutable/,
  );
});

test('验收更正只使必要的较新发票失效，跨PO行的预占一并释放', async () => {
  const rec = new Reconciler([
    { poLineId: 'A', unitPriceCents: 100 },
    { poLineId: 'B', unitPriceCents: 100 },
  ]);
  rec.setReceipt('R1', 'A', 10);
  rec.setReceipt('R2', 'B', 10);
  const gate = reviewGate();
  const flagged = (qty: number) => qty * 100 + 6000; // diff=6000 > max(5000, 5%)

  // I1（最旧）：只占 R1
  const p1 = rec.reconcile('I1', [{ poLineId: 'A', quantity: 4, amountCents: flagged(4) }], gate.review);
  // I2：跨两个PO行，占 R1 与 R2
  const p2 = rec.reconcile(
    'I2',
    [
      { poLineId: 'A', quantity: 3, amountCents: flagged(3) },
      { poLineId: 'B', quantity: 5, amountCents: flagged(5) },
    ],
    gate.review,
  );
  // I3（最新）：只占 R1
  const p3 = rec.reconcile('I3', [{ poLineId: 'A', quantity: 3, amountCents: flagged(3) }], gate.review);
  assert.equal(gate.calls.length, 3);
  assert.equal(rec.snapshot().receipts[0]!.heldQty, 10);

  // R1: 10 -> 7，超额3，只需失效最新的 I3；I1、I2 不受影响
  rec.setReceipt('R1', 'A', 7);
  let snap = rec.snapshot();
  const statusOf = (s: Snapshot, id: string) => s.invoices.find((i) => i.invoiceId === id)!.status;
  assert.equal(statusOf(snap, 'I3'), 'invalidated');
  assert.equal(statusOf(snap, 'I2'), 'pending-review');
  assert.equal(statusOf(snap, 'I1'), 'pending-review');
  assert.equal(snap.receipts[0]!.heldQty, 7);
  assert.equal(snap.receipts[1]!.heldQty, 5, 'I2 在 R2 上的预占保留');

  // R1: 7 -> 4，超额3，失效 I2；I2 在另一PO行 R2 上的预占必须一并释放；I1 保留
  rec.setReceipt('R1', 'A', 4);
  snap = rec.snapshot();
  assert.equal(statusOf(snap, 'I2'), 'invalidated');
  assert.equal(statusOf(snap, 'I1'), 'pending-review');
  assert.equal(snap.receipts[0]!.heldQty, 4);
  assert.equal(snap.receipts[1]!.heldQty, 0, '失效必须释放该发票在其他验收记录上的全部预占');
  assert.deepEqual(snap.invoices.find((i) => i.invoiceId === 'I2')!.allocations, []);

  // 被失效的 review 稍后返回，不得再授权
  gate.gates[2]!.resolve(true); // I3
  gate.gates[1]!.resolve(true); // I2
  assert.equal((await p3).status, 'failed');
  assert.equal((await p2).status, 'failed');
  gate.gates[0]!.resolve(true); // I1
  assert.deepEqual(await p1, { status: 'authorized' });
  snap = rec.snapshot();
  assert.equal(snap.receipts[0]!.authorizedQty, 4);
  assert.equal(snap.receipts[0]!.heldQty, 0);
});

test('数量增加或仅减少未占用部分不得使发票失效', async () => {
  const rec = new Reconciler([{ poLineId: 'A', unitPriceCents: 100 }]);
  rec.setReceipt('R1', 'A', 10);
  const gate = reviewGate();
  const p = rec.reconcile('I1', [{ poLineId: 'A', quantity: 4, amountCents: 6400 }], gate.review);
  rec.setReceipt('R1', 'A', 20); // 增加
  rec.setReceipt('R1', 'A', 4); // 减少到恰好等于占用
  assert.equal(rec.snapshot().invoices[0]!.status, 'pending-review');
  assert.equal(rec.snapshot().receipts[0]!.heldQty, 4);
  gate.gates[0]!.resolve(true);
  assert.deepEqual(await p, { status: 'authorized' });
});

test('低于已授权数量的更正失败且整个状态保持不变', async () => {
  const rec = new Reconciler([
    { poLineId: 'A', unitPriceCents: 100 },
    { poLineId: 'B', unitPriceCents: 100 },
  ]);
  rec.setReceipt('R1', 'A', 10);
  rec.setReceipt('R2', 'B', 10);
  const gate = reviewGate();
  // I1 无价差直接授权，占 R1 四件
  await rec.reconcile('I1', [{ poLineId: 'A', quantity: 4, amountCents: 400 }], gate.review);
  // I2 有待复核预占，跨 R1/R2
  const p2 = rec.reconcile(
    'I2',
    [
      { poLineId: 'A', quantity: 3, amountCents: 6300 },
      { poLineId: 'B', quantity: 5, amountCents: 6500 },
    ],
    gate.review,
  );
  const before = rec.snapshot();
  assert.throws(() => rec.setReceipt('R1', 'A', 3), /below authorized qty/);
  assert.throws(() => rec.setReceipt('R1', 'B', 10), /already belongs to/);
  assert.deepEqual(rec.snapshot(), before, '失败的更正不得改变任何状态');
  gate.gates[0]!.resolve(true);
  assert.deepEqual(await p2, { status: 'authorized' });
});

test('按验收记录首次创建顺序分配未占用数量', async () => {
  const rec = new Reconciler([{ poLineId: 'A', unitPriceCents: 100 }]);
  rec.setReceipt('R1', 'A', 2);
  rec.setReceipt('R2', 'A', 5);
  const gate = reviewGate();
  await rec.reconcile('I1', [{ poLineId: 'A', quantity: 4, amountCents: 400 }], gate.review);
  const snap = rec.snapshot();
  const inv = snap.invoices[0]!;
  assert.deepEqual(inv.allocations, [
    { receiptId: 'R1', quantity: 2 },
    { receiptId: 'R2', quantity: 2 },
  ]);
  assert.equal(snap.receipts[0]!.availableQty, 0);
  assert.equal(snap.receipts[1]!.availableQty, 3);
});

test('输入校验：发票数量必须为正整数，验收批准数量允许为零', async () => {
  const rec = new Reconciler([{ poLineId: 'A', unitPriceCents: 100 }]);
  rec.setReceipt('R1', 'A', 0); // 允许为零
  const gate = reviewGate();
  await assert.rejects(rec.reconcile('I1', [{ poLineId: 'A', quantity: 0, amountCents: 0 }], gate.review), /positive integer/);
  await assert.rejects(rec.reconcile('I2', [{ poLineId: 'A', quantity: 1.5, amountCents: 100 }], gate.review), /positive integer/);
  assert.throws(() => rec.setReceipt('R2', 'A', -1), /non-negative integer/);
  assert.throws(() => rec.setReceipt('R2', 'NOPE', 1), /unknown poLineId/);
});
