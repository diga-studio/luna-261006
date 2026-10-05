import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PayrollClose } from '../src/index.js';
import type { CloseBatchResult, Estimator } from '../src/index.js';

/** 应付额等于月薪的估算器。 */
const identityEstimator: Estimator = async (_employeeId, _month, monthlySalary) => monthlySalary;

function freshDbPath(): { dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'payroll-close-'));
  return { dir, dbPath: join(dir, 'payroll.sqlite') };
}

function employeeLines(result: CloseBatchResult, employeeId: string) {
  const found = result.employees.find((e) => e.employeeId === employeeId);
  assert.ok(found, `employee ${employeeId} missing in result`);
  return found;
}

test('追溯改薪后的差额追补与旧记录不变', async (t) => {
  const { dir, dbPath } = freshDbPath();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const payroll = await PayrollClose.open(dbPath, identityEstimator);
  t.after(() => payroll.close());

  await payroll.initEmployees([
    { employeeId: 'e1', hireMonth: '2025-01', initialSalary: 10000 },
  ]);

  // 1、2 月各关账 10000 分
  const jan = await payroll.closeBatch('req-jan', ['e1'], '2025-01');
  assert.equal(jan.status, 'closed');
  assert.equal(employeeLines(jan, 'e1').total, 10000);
  const feb = await payroll.closeBatch('req-feb', ['e1'], '2025-02');
  assert.equal(employeeLines(feb, 'e1').total, 10000);
  assert.deepEqual(employeeLines(feb, 'e1').lines, [
    { month: '2025-01', amount: 0 },
    { month: '2025-02', amount: 10000 },
  ]);

  // 1 月起 12000、3 月起 13000，随后 1 月改成 11000（同月替换，乱序生效）
  await payroll.setSalary('e1', '2025-01', 12000);
  await payroll.setSalary('e1', '2025-03', 13000);
  await payroll.setSalary('e1', '2025-01', 11000);

  // 3 月关账：1、2 月各追补 1000，3 月应付 13000，合计 15000
  const mar = await payroll.closeBatch('req-mar', ['e1'], '2025-03');
  assert.equal(mar.status, 'closed');
  assert.deepEqual(employeeLines(mar, 'e1').lines, [
    { month: '2025-01', amount: 1000 },
    { month: '2025-02', amount: 1000 },
    { month: '2025-03', amount: 13000 },
  ]);
  assert.equal(employeeLines(mar, 'e1').total, 15000);

  // 4 月关账：历史无差额，仅当月 13000
  const apr = await payroll.closeBatch('req-apr', ['e1'], '2025-04');
  assert.deepEqual(employeeLines(apr, 'e1').lines, [
    { month: '2025-01', amount: 0 },
    { month: '2025-02', amount: 0 },
    { month: '2025-03', amount: 0 },
    { month: '2025-04', amount: 13000 },
  ]);
  assert.equal(employeeLines(apr, 'e1').total, 13000);

  // 旧记录不被改写
  const janReplay = await payroll.getCloseResult('req-jan');
  assert.ok(janReplay);
  assert.equal(employeeLines(janReplay, 'e1').total, 10000);
  assert.deepEqual(employeeLines(janReplay, 'e1').lines, [
    { month: '2025-01', amount: 10000 },
  ]);
  const marReplay = await payroll.getCloseResult('req-mar');
  assert.ok(marReplay);
  assert.equal(employeeLines(marReplay, 'e1').total, 15000);
});

test('同一请求标识重试幂等：改薪后重试结果不变且只入账一份', async (t) => {
  const { dir, dbPath } = freshDbPath();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const payroll = await PayrollClose.open(dbPath, identityEstimator);
  t.after(() => payroll.close());

  await payroll.initEmployees([
    { employeeId: 'e1', hireMonth: '2025-01', initialSalary: 10000 },
  ]);

  const first = await payroll.closeBatch('req-x', ['e1'], '2025-02');
  assert.equal(first.status, 'closed');
  assert.equal(employeeLines(first, 'e1').total, 20000);

  // 改薪后重试同一请求标识
  await payroll.setSalary('e1', '2025-01', 15000);
  const retry = await payroll.closeBatch('req-x', ['e1'], '2025-02');
  assert.deepEqual(retry, first);
  const replay = await payroll.getCloseResult('req-x');
  assert.deepEqual(replay, first);

  // 实际入账仅一份：3 月关账时 1、2 月只按一份 10000 归属计算追补
  const mar = await payroll.closeBatch('req-y', ['e1'], '2025-03');
  assert.deepEqual(employeeLines(mar, 'e1').lines, [
    { month: '2025-01', amount: 5000 },
    { month: '2025-02', amount: 5000 },
    { month: '2025-03', amount: 15000 },
  ]);
  assert.equal(employeeLines(mar, 'e1').total, 25000);
});

test('员工与月份交集冲突：整批不入账，未重叠员工不留记录', async (t) => {
  const { dir, dbPath } = freshDbPath();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const payroll = await PayrollClose.open(dbPath, identityEstimator);
  t.after(() => payroll.close());

  await payroll.initEmployees([
    { employeeId: 'e1', hireMonth: '2025-01', initialSalary: 10000 },
    { employeeId: 'e2', hireMonth: '2025-01', initialSalary: 20000 },
  ]);

  const a = await payroll.closeBatch('req-a', ['e1'], '2025-02');
  assert.equal(a.status, 'closed');

  // e1 的 2025-02 已被 req-a 关账，整批冲突；e2 不得留下任何记录
  const b = await payroll.closeBatch('req-b', ['e1', 'e2'], '2025-02');
  assert.equal(b.status, 'conflict');
  assert.deepEqual(b.employees, []);
  assert.equal(await payroll.getCloseResult('req-b'), null);

  // e2 未消耗任何追补，可正常从入职月关账
  const c = await payroll.closeBatch('req-c', ['e2'], '2025-02');
  assert.equal(c.status, 'closed');
  assert.equal(employeeLines(c, 'e2').total, 40000);
  assert.deepEqual(employeeLines(c, 'e2').lines, [
    { month: '2025-01', amount: 20000 },
    { month: '2025-02', amount: 20000 },
  ]);
});

test('应付额下调产生负差额', async (t) => {
  const { dir, dbPath } = freshDbPath();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const payroll = await PayrollClose.open(dbPath, identityEstimator);
  t.after(() => payroll.close());

  await payroll.initEmployees([
    { employeeId: 'e1', hireMonth: '2025-01', initialSalary: 10000 },
  ]);
  await payroll.closeBatch('req-1', ['e1'], '2025-02');

  await payroll.setSalary('e1', '2025-02', 8000);
  const mar = await payroll.closeBatch('req-2', ['e1'], '2025-03');
  assert.deepEqual(employeeLines(mar, 'e1').lines, [
    { month: '2025-01', amount: 0 },
    { month: '2025-02', amount: -2000 },
    { month: '2025-03', amount: 8000 },
  ]);
  assert.equal(employeeLines(mar, 'e1').total, 6000);
});

test('数据持久化：重开数据库后关账结果与归属金额保持', async (t) => {
  const { dir, dbPath } = freshDbPath();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const first = await PayrollClose.open(dbPath, identityEstimator);
  await first.initEmployees([
    { employeeId: 'e1', hireMonth: '2025-01', initialSalary: 10000 },
  ]);
  await first.closeBatch('req-1', ['e1'], '2025-01');
  await first.setSalary('e1', '2025-01', 12000);
  await first.close();

  const reopened = await PayrollClose.open(dbPath, identityEstimator);
  t.after(() => reopened.close());
  const replay = await reopened.getCloseResult('req-1');
  assert.ok(replay);
  assert.equal(employeeLines(replay, 'e1').total, 10000);

  const feb = await reopened.closeBatch('req-2', ['e1'], '2025-02');
  assert.deepEqual(employeeLines(feb, 'e1').lines, [
    { month: '2025-01', amount: 2000 },
    { month: '2025-02', amount: 12000 },
  ]);
});
