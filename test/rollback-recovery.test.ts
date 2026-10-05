import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CanaryCoordinator, StepPoint } from '../src/index';
import {
  createBizDb,
  getVersion,
  makeWorkspace,
  queryAll,
  seqValue,
  tableExists,
} from './helpers';

const START_VERSION = 3;

function setupSql(hasP2: boolean): string {
  return `
    CREATE TABLE parents (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);
    CREATE TABLE children (id INTEGER PRIMARY KEY AUTOINCREMENT, pid INTEGER NOT NULL REFERENCES parents(id), note TEXT);
    INSERT INTO parents (id, name) VALUES (1, 'p1');
    ${hasP2 ? "INSERT INTO parents (id, name) VALUES (2, 'p2');" : "INSERT INTO parents (id, name) VALUES (9, 'p9');"}
    INSERT INTO children (pid, note) VALUES (1, 'c1');
  `;
}

const MIGRATION_SQL = `
  DELETE FROM children WHERE note = 'c1';
  INSERT INTO parents (name) VALUES ('p3');
  CREATE TABLE newcol (id INTEGER PRIMARY KEY, pid INTEGER NOT NULL REFERENCES parents(id));
  INSERT INTO newcol (pid) VALUES (2);
`;

function setupWorkspace(dbCount: number) {
  const ws = makeWorkspace(dbCount);
  createBizDb(ws.dbPaths[0], START_VERSION, setupSql(true));
  createBizDb(ws.dbPaths[1], START_VERSION, setupSql(true));
  createBizDb(ws.dbPaths[2], START_VERSION, setupSql(false));
  return ws;
}

function assertFullyRestored(dbPaths: string[]): void {
  for (const p of dbPaths) {
    assert.equal(getVersion(p), START_VERSION);
    const notes = queryAll(p, "SELECT note FROM children WHERE note = 'c1'").map((r) => r.note);
    assert.deepEqual(notes, ['c1']);
    assert.deepEqual(queryAll(p, "SELECT name FROM parents WHERE name = 'p3'"), []);
    assert.equal(tableExists(p, 'newcol'), false);
  }
  assert.equal(seqValue(dbPaths[0], 'parents'), 2);
  assert.equal(seqValue(dbPaths[1], 'parents'), 2);
  assert.equal(seqValue(dbPaths[2], 'parents'), 9);
}

/** 第 crashOnNth 次命中目标步骤时模拟进程被杀 */
function crashAfterNth(point: StepPoint, n: number) {
  let count = 0;
  return (p: StepPoint) => {
    if (p === point) {
      count++;
      if (count === n) throw new Error(`simulated crash at ${point} #${n}`);
    }
  };
}

test('撤回中途进程终止：恢复后完成撤回，全部库回到提交前状态', () => {
  const ws = setupWorkspace(3);
  try {
    const hook = crashAfterNth('db-rolled-back', 1);
    const crashing = new CanaryCoordinator({
      stateDbPath: ws.stateDbPath,
      onStep: (point) => hook(point),
    });
    crashing.submit({
      batchId: 'batch-rollback-crash',
      dbPaths: ws.dbPaths,
      startVersion: START_VERSION,
      sql: MIGRATION_SQL,
    });
    assert.throws(() => crashing.advance('batch-rollback-crash'), /simulated crash/);

    // 批次处于撤回中：部分库已撤回，部分库仍是新版本
    const resumed = new CanaryCoordinator({ stateDbPath: ws.stateDbPath });
    assert.equal(resumed.query('batch-rollback-crash').status, 'rolling_back');

    const progress = resumed.advance('batch-rollback-crash');
    assert.equal(progress.status, 'failed');
    assertFullyRestored(ws.dbPaths);
    resumed.close();
  } finally {
    ws.cleanup();
  }
});

test('恢复期间再次终止：多次重启后撤回仍收敛到失败终态', () => {
  const ws = setupWorkspace(3);
  try {
    const batchId = 'batch-rollback-crash-twice';
    const run1 = new CanaryCoordinator({
      stateDbPath: ws.stateDbPath,
      onStep: (point) => crashAfterNth('db-rolled-back', 1)(point),
    });
    run1.submit({
      batchId,
      dbPaths: ws.dbPaths,
      startVersion: START_VERSION,
      sql: MIGRATION_SQL,
    });
    assert.throws(() => run1.advance(batchId), /simulated crash/);

    // 恢复过程再次被杀
    const run2 = new CanaryCoordinator({
      stateDbPath: ws.stateDbPath,
      onStep: (point) => crashAfterNth('db-rolled-back', 1)(point),
    });
    assert.throws(() => run2.advance(batchId), /simulated crash/);
    assert.equal(
      new CanaryCoordinator({ stateDbPath: ws.stateDbPath }).query(batchId).status,
      'rolling_back',
    );

    // 第三次推进完成撤回
    const run3 = new CanaryCoordinator({ stateDbPath: ws.stateDbPath });
    const progress = run3.advance(batchId);
    assert.equal(progress.status, 'failed');
    assert.deepEqual(
      progress.dbs.map((d) => d.state),
      ['rolled_back', 'rolled_back', 'rolled_back'],
    );
    assertFullyRestored(ws.dbPaths);
    run3.close();
  } finally {
    ws.cleanup();
  }
});
