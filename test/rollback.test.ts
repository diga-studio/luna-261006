import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CanaryCoordinator } from '../src/index';
import {
  createBizDb,
  getVersion,
  makeWorkspace,
  queryAll,
  seqValue,
  tableExists,
} from './helpers';

const START_VERSION = 3;

// 各库初始数据不同：前两个库存在 parent id=2，末库不存在（且自增进度不同）
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

test('金丝雀成功而末库违反外键约束时，整批撤回并恢复数据、版本与自增进度', () => {
  const ws = makeWorkspace(3);
  try {
    createBizDb(ws.dbPaths[0], START_VERSION, setupSql(true));
    createBizDb(ws.dbPaths[1], START_VERSION, setupSql(true));
    createBizDb(ws.dbPaths[2], START_VERSION, setupSql(false)); // 数据差异：缺少 parent id=2

    const coordinator = new CanaryCoordinator({ stateDbPath: ws.stateDbPath });
    const submitted = coordinator.submit({
      batchId: 'batch-fk-fail',
      dbPaths: ws.dbPaths,
      startVersion: START_VERSION,
      sql: MIGRATION_SQL,
    });
    assert.equal(submitted.status, 'publishing');

    const progress = coordinator.advance('batch-fk-fail');
    assert.equal(progress.status, 'failed');
    assert.deepEqual(
      progress.dbs.map((d) => d.state),
      ['rolled_back', 'rolled_back', 'rolled_back'],
    );

    for (const dbPath of ws.dbPaths) {
      // 版本恢复
      assert.equal(getVersion(dbPath), START_VERSION);
      // 被迁移删除的数据恢复
      const notes = queryAll(dbPath, "SELECT note FROM children WHERE note = 'c1'").map(
        (r) => r.note,
      );
      assert.deepEqual(notes, ['c1']);
      // 迁移插入的数据被撤回
      assert.deepEqual(queryAll(dbPath, "SELECT name FROM parents WHERE name = 'p3'"), []);
      // 新结构被撤回
      assert.equal(tableExists(dbPath, 'newcol'), false);
    }
    // 自增进度恢复（迁移曾在各库把 parents 序列各推进 1）
    assert.equal(seqValue(ws.dbPaths[0], 'parents'), 2);
    assert.equal(seqValue(ws.dbPaths[1], 'parents'), 2);
    assert.equal(seqValue(ws.dbPaths[2], 'parents'), 9);

    // 查询接口同样报告失败终态
    const queried = coordinator.query('batch-fk-fail');
    assert.equal(queried.status, 'failed');
    coordinator.close();
  } finally {
    ws.cleanup();
  }
});
