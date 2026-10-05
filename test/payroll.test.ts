import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CloseConflictError, PayrollService, type Month, type PayEstimator } from '../src/index';

const defaultEstimate: PayEstimator = async (_id, _month, salary) => salary;

function makeService(estimatePay: PayEstimator = defaultEstimate) {
  const dir = mkdtempSync(join(tmpdir(), 'payroll-test-'));
  const dbPath = join(dir, 'payroll.db');
  const service = new PayrollService({ dbPath, estimatePay });
  return {
    service,
    dbPath,
    cleanup: () => { rmSync(dir, { recursive: true, force: true }); },
  };
}

test('追溯改薪后差额并入下一次关账，旧记录不变', async () => {
  const { service, cleanup } = makeService();
  try {
    await service.initEmployees([{ employeeId: 'e1', hireMonth: '2026-01', baseSalary: 10000 }]);

    const jan = await service.closeBatch('req-jan', ['e1'], '2026-01');
    assert.equal(jan.total, 10000);
    const feb = await service.closeBatch('req-feb', ['e1'], '2026-02');
    assert.equal(feb.total, 10000);

    await service.setSalary('e1', '2026-01', 12000);
    await service.setSalary('e1', '2026-03', 13000);
    await service.setSalary('e1', '2026-01', 11000); // 同月改薪替换原值

    const mar = await service.closeBatch('req-mar', ['e1'], '2026-03');
    assert.equal(mar.total, 15000);
    assert.deepEqual(
      mar.employees[0].lines.map((l) => [l.month, l.amount]),
      [['2026-01', 1000], ['2026-02', 1000], ['2026-03', 13000]],
    );

    const apr = await service.closeBatch('req-apr', ['e1'], '2026-04');
    assert.equal(apr.total, 13000);
    assert.deepEqual(
      apr.employees[0].lines.map((l) => [l.month, l.amount]),
      [['2026-01', 0], ['2026-02', 0], ['2026-03', 0], ['2026-04', 13000]],
    );

    // 已入账记录永不改写
    assert.equal((await service.getCloseResult('req-jan'))!.total, 10000);
    assert.equal((await service.getCloseResult('req-feb'))!.total, 10000);
    assert.equal((await service.getCloseResult('req-mar'))!.total, 15000);
    service.close();
  } finally {
    cleanup();
  }
});

test('同一请求标识重试只产生一份结果，改薪不影响回放', async () => {
  const { service, cleanup } = makeService();
  try {
    await service.initEmployees([{ employeeId: 'e1', hireMonth: '2026-01', baseSalary: 10000 }]);

    const first = await service.closeBatch('req-a', ['e1'], '2026-02');
    assert.equal(first.total, 20000);

    await service.setSalary('e1', '2026-01', 15000);

    const retry = await service.closeBatch('req-a', ['e1'], '2026-02');
    assert.deepEqual(retry, first);

    const replay = await service.getCloseResult('req-a');
    assert.deepEqual(replay, first);

    // 实际入账仅一份：后续关账不会因重试而重复扣减
    const mar = await service.closeBatch('req-b', ['e1'], '2026-03');
    assert.deepEqual(
      mar.employees[0].lines.map((l) => [l.month, l.amount]),
      [['2026-01', 5000], ['2026-02', 5000], ['2026-03', 15000]],
    );
    service.close();
  } finally {
    cleanup();
  }
});

test('不同请求在相同员工与月份相交时整体冲突，未重叠员工不留记录', async () => {
  const { service, cleanup } = makeService();
  try {
    await service.initEmployees([
      { employeeId: 'e1', hireMonth: '2026-01', baseSalary: 10000 },
      { employeeId: 'e2', hireMonth: '2026-01', baseSalary: 20000 },
    ]);

    await service.closeBatch('req-1', ['e1'], '2026-01');

    await assert.rejects(
      service.closeBatch('req-2', ['e1', 'e2'], '2026-01'),
      (err: unknown) => {
        assert.ok(err instanceof CloseConflictError);
        assert.deepEqual(err.conflicts, [{ employeeId: 'e1', month: '2026-01' }]);
        return true;
      },
    );

    // 冲突批次整体不入账：e2 没有任何记录，之后可正常关账
    assert.equal(await service.getCloseResult('req-2'), null);
    const feb = await service.closeBatch('req-3', ['e2'], '2026-02');
    assert.equal(feb.total, 40000);

    // 不同请求、相同员工但月份不相交（追补场景）不冲突
    const mar = await service.closeBatch('req-4', ['e1'], '2026-03');
    assert.equal(mar.total, 20000);
    service.close();
  } finally {
    cleanup();
  }
});

test('估算能力决定应付额，允许负差额', async () => {
  const { service, dbPath, cleanup } = makeService(async (_id, _month, salary) => salary * 2);
  try {
    await service.initEmployees([{ employeeId: 'e1', hireMonth: '2026-01', baseSalary: 10000 }]);
    const jan = await service.closeBatch('req-1', ['e1'], '2026-01');
    assert.equal(jan.total, 20000);
    service.close();

    // 估算规则变化后重开同一数据库，次月关账对 1 月产生负追补
    const svc2 = new PayrollService({
      dbPath,
      estimatePay: async (_id, _month, salary) => salary / 2,
    });
    try {
      const feb = await svc2.closeBatch('req-2', ['e1'], '2026-02');
      assert.deepEqual(
        feb.employees[0].lines.map((l) => [l.month, l.amount]),
        [['2026-01', -15000], ['2026-02', 5000]],
      );
      assert.equal(feb.total, -10000);
    } finally {
      svc2.close();
    }
  } finally {
    cleanup();
  }
});
