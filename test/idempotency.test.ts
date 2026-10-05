import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { BatchError, CanaryCoordinator } from '../src/index';
import { createBizDb, getVersion, makeWorkspace, queryAll, tableExists } from './helpers';

const SETUP_SQL = `
  CREATE TABLE counters (id INTEGER PRIMARY KEY, n INTEGER NOT NULL);
  INSERT INTO counters (id, n) VALUES (1, 0);
`;
const PLUS_ONE_SQL = 'UPDATE counters SET n = n + 1;';

function counterValue(dbPath: string): number {
  return queryAll(dbPath, 'SELECT n FROM counters WHERE id = 1')[0].n as number;
}

function fileHash(p: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

test('旧批次重试不会覆盖后来成功批次的数据', () => {
  const ws = makeWorkspace(2);
  try {
    for (const p of ws.dbPaths) createBizDb(p, 0, SETUP_SQL);
    const coordinator = new CanaryCoordinator({ stateDbPath: ws.stateDbPath });

    // 批次 A：0 -> 1
    coordinator.submit({
      batchId: 'batch-a',
      dbPaths: ws.dbPaths,
      startVersion: 0,
      sql: PLUS_ONE_SQL,
    });
    assert.equal(coordinator.advance('batch-a').status, 'succeeded');

    // 批次 B：1 -> 2（后来成功的批次）
    coordinator.submit({
      batchId: 'batch-b',
      dbPaths: ws.dbPaths,
      startVersion: 1,
      sql: PLUS_ONE_SQL,
    });
    assert.equal(coordinator.advance('batch-b').status, 'succeeded');
    for (const p of ws.dbPaths) {
      assert.equal(counterValue(p), 2);
      assert.equal(getVersion(p), 2);
    }

    const hashesBefore = ws.dbPaths.map(fileHash);

    // 重试旧标识：重复提交返回原批次，推进是 no-op
    const resubmitted = coordinator.submit({
      batchId: 'batch-a',
      dbPaths: ws.dbPaths,
      startVersion: 0,
      sql: PLUS_ONE_SQL,
    });
    assert.equal(resubmitted.status, 'succeeded');
    assert.equal(coordinator.advance('batch-a').status, 'succeeded');

    // 文件未被再次修改
    assert.deepEqual(ws.dbPaths.map(fileHash), hashesBefore);
    for (const p of ws.dbPaths) {
      assert.equal(counterValue(p), 2);
      assert.equal(getVersion(p), 2);
    }
    coordinator.close();
  } finally {
    ws.cleanup();
  }
});

test('发布中的批次重复提交返回原批次，且与后续推进互不干扰', () => {
  const ws = makeWorkspace(2);
  try {
    for (const p of ws.dbPaths) createBizDb(p, 0, SETUP_SQL);
    const coordinator = new CanaryCoordinator({ stateDbPath: ws.stateDbPath });
    const req = {
      batchId: 'batch-dup',
      dbPaths: ws.dbPaths,
      startVersion: 0,
      sql: PLUS_ONE_SQL,
    };
    const first = coordinator.submit(req);
    const second = coordinator.submit(req);
    assert.equal(first.status, 'publishing');
    assert.equal(second.status, 'publishing');
    assert.equal(coordinator.advance('batch-dup').status, 'succeeded');
    for (const p of ws.dbPaths) assert.equal(counterValue(p), 1);
    coordinator.close();
  } finally {
    ws.cleanup();
  }
});

test('非法请求被拒绝：库数量、重复库、空 SQL、空标识', () => {
  const ws = makeWorkspace(2);
  try {
    const coordinator = new CanaryCoordinator({ stateDbPath: ws.stateDbPath });
    const base = { batchId: 'x', dbPaths: ws.dbPaths, startVersion: 0, sql: PLUS_ONE_SQL };
    assert.throws(() => coordinator.submit({ ...base, dbPaths: [] }), BatchError);
    assert.throws(
      () => coordinator.submit({ ...base, dbPaths: Array(21).fill('a.db') }),
      BatchError,
    );
    assert.throws(
      () => coordinator.submit({ ...base, dbPaths: [ws.dbPaths[0], ws.dbPaths[0]] }),
      /duplicates/,
    );
    assert.throws(() => coordinator.submit({ ...base, sql: '' }), BatchError);
    assert.throws(() => coordinator.submit({ ...base, batchId: '' }), BatchError);
    assert.throws(
      () => coordinator.submit({ ...base, startVersion: -1 }),
      BatchError,
    );
    coordinator.close();
  } finally {
    ws.cleanup();
  }
});

test('同一时刻最多一个未结束批次；未知批次查询报错', () => {
  const ws = makeWorkspace(2);
  try {
    for (const p of ws.dbPaths) createBizDb(p, 0, SETUP_SQL);
    const coordinator = new CanaryCoordinator({ stateDbPath: ws.stateDbPath });
    coordinator.submit({
      batchId: 'batch-open',
      dbPaths: ws.dbPaths,
      startVersion: 0,
      sql: PLUS_ONE_SQL,
    });
    assert.throws(
      () =>
        coordinator.submit({
          batchId: 'batch-other',
          dbPaths: ws.dbPaths,
          startVersion: 0,
          sql: PLUS_ONE_SQL,
        }),
      /BATCH_IN_PROGRESS|still publishing/,
    );
    assert.throws(() => coordinator.query('no-such-batch'), /unknown batch/);
    assert.throws(() => coordinator.advance('no-such-batch'), /unknown batch/);
    coordinator.close();
  } finally {
    ws.cleanup();
  }
});

test('金丝雀本身失败时，其余库完全不被触碰', () => {
  const ws = makeWorkspace(3);
  try {
    for (const p of ws.dbPaths) createBizDb(p, 0, SETUP_SQL);
    const hashesBefore = ws.dbPaths.slice(1).map(fileHash);
    const coordinator = new CanaryCoordinator({ stateDbPath: ws.stateDbPath });
    coordinator.submit({
      batchId: 'batch-canary-fails',
      dbPaths: ws.dbPaths,
      startVersion: 0,
      sql: 'UPDATE no_such_table SET n = 1; CREATE TABLE added (id INTEGER PRIMARY KEY);',
    });
    const progress = coordinator.advance('batch-canary-fails');
    assert.equal(progress.status, 'failed');
    // 金丝雀恢复原状
    assert.equal(getVersion(ws.dbPaths[0]), 0);
    assert.equal(tableExists(ws.dbPaths[0], 'added'), false);
    // 其余库文件字节级未变
    assert.deepEqual(ws.dbPaths.slice(1).map(fileHash), hashesBefore);
    coordinator.close();
  } finally {
    ws.cleanup();
  }
});
