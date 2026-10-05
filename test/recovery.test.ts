import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CanaryCoordinator, StepPoint } from '../src/index';
import { createBizDb, getVersion, makeWorkspace, queryAll, tableExists } from './helpers';

const START_VERSION = 0;
const SETUP_SQL = `
  CREATE TABLE counters (id INTEGER PRIMARY KEY, n INTEGER NOT NULL);
  INSERT INTO counters (id, n) VALUES (1, 0);
`;
// 含累计加值的非幂等数据迁移：成功恢复后每库只能产生一次效果
const MIGRATION_SQL = `
  UPDATE counters SET n = n + 1;
  CREATE TABLE added (id INTEGER PRIMARY KEY);
`;

function counterValue(dbPath: string): number {
  const rows = queryAll(dbPath, 'SELECT n FROM counters WHERE id = 1');
  return rows[0].n as number;
}

function crashAt(
  predicate: (point: StepPoint, dbPath: string | undefined) => boolean,
): (point: StepPoint, ctx: { dbPath?: string }) => void {
  return (point, ctx) => {
    if (predicate(point, ctx.dbPath)) {
      throw new Error(`simulated crash at ${point}`);
    }
  };
}

test('金丝雀已提交但批次未确认时进程终止：恢复后继续发布且每库只迁移一次', () => {
  const ws = makeWorkspace(3);
  try {
    for (const p of ws.dbPaths) createBizDb(p, START_VERSION, SETUP_SQL);

    const first = new CanaryCoordinator({
      stateDbPath: ws.stateDbPath,
      onStep: crashAt((point, dbPath) => point === 'db-committed' && dbPath === ws.dbPaths[0]),
    });
    first.submit({
      batchId: 'batch-crash-after-canary',
      dbPaths: ws.dbPaths,
      startVersion: START_VERSION,
      sql: MIGRATION_SQL,
    });
    assert.throws(() => first.advance('batch-crash-after-canary'), /simulated crash/);
    // 模拟进程被杀：丢弃旧实例，不调用 close

    // 金丝雀已真实提交：新连接能读到新结构、数据与版本
    assert.equal(getVersion(ws.dbPaths[0]), START_VERSION + 1);
    assert.equal(tableExists(ws.dbPaths[0], 'added'), true);
    assert.equal(counterValue(ws.dbPaths[0]), 1);
    // 其余库尚未发布
    assert.equal(getVersion(ws.dbPaths[1]), START_VERSION);
    assert.equal(getVersion(ws.dbPaths[2]), START_VERSION);

    // 重新打开并继续推进
    const second = new CanaryCoordinator({ stateDbPath: ws.stateDbPath });
    const progress = second.advance('batch-crash-after-canary');
    assert.equal(progress.status, 'succeeded');

    // 累计加值在每库只生效一次（金丝雀不会先退回再重做）
    for (const p of ws.dbPaths) {
      assert.equal(counterValue(p), 1);
      assert.equal(getVersion(p), START_VERSION + 1);
      assert.equal(tableExists(p, 'added'), true);
    }
    second.close();
  } finally {
    ws.cleanup();
  }
});

test('备份完成后、迁移提交前进程终止：恢复后重新迁移且只生效一次', () => {
  const ws = makeWorkspace(2);
  try {
    for (const p of ws.dbPaths) createBizDb(p, START_VERSION, SETUP_SQL);

    const first = new CanaryCoordinator({
      stateDbPath: ws.stateDbPath,
      onStep: crashAt((point, dbPath) => point === 'backup-created' && dbPath === ws.dbPaths[0]),
    });
    first.submit({
      batchId: 'batch-crash-after-backup',
      dbPaths: ws.dbPaths,
      startVersion: START_VERSION,
      sql: MIGRATION_SQL,
    });
    assert.throws(() => first.advance('batch-crash-after-backup'), /simulated crash/);
    // 金丝雀尚未提交
    assert.equal(getVersion(ws.dbPaths[0]), START_VERSION);

    const second = new CanaryCoordinator({ stateDbPath: ws.stateDbPath });
    assert.equal(second.advance('batch-crash-after-backup').status, 'succeeded');
    for (const p of ws.dbPaths) {
      assert.equal(counterValue(p), 1);
      assert.equal(getVersion(p), START_VERSION + 1);
    }
    second.close();
  } finally {
    ws.cleanup();
  }
});

test('全部库已提交但终态未确认时进程终止：恢复后直接确认成功且不重复迁移', () => {
  const ws = makeWorkspace(3);
  try {
    for (const p of ws.dbPaths) createBizDb(p, START_VERSION, SETUP_SQL);

    const lastDb = ws.dbPaths[ws.dbPaths.length - 1];
    const first = new CanaryCoordinator({
      stateDbPath: ws.stateDbPath,
      onStep: crashAt((point, dbPath) => point === 'db-committed' && dbPath === lastDb),
    });
    first.submit({
      batchId: 'batch-crash-before-confirm',
      dbPaths: ws.dbPaths,
      startVersion: START_VERSION,
      sql: MIGRATION_SQL,
    });
    assert.throws(() => first.advance('batch-crash-before-confirm'), /simulated crash/);

    // 所有库都已提交，但批次状态仍是 publishing
    for (const p of ws.dbPaths) assert.equal(getVersion(p), START_VERSION + 1);
    const second = new CanaryCoordinator({ stateDbPath: ws.stateDbPath });
    assert.equal(second.query('batch-crash-before-confirm').status, 'publishing');

    const progress = second.advance('batch-crash-before-confirm');
    assert.equal(progress.status, 'succeeded');
    // 累计加值没有重复生效
    for (const p of ws.dbPaths) assert.equal(counterValue(p), 1);
    second.close();
  } finally {
    ws.cleanup();
  }
});
