import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as path from "path";
import { AdvanceHooks, CanaryMigrator } from "../src/index";
import { CUMULATIVE_SQL, SimulatedCrash, createDb, dumpDb, mkTmpDir, standardFixture } from "./helpers";

function setup(dir: string, count: number): string[] {
  const dbs = Array.from({ length: count }, (_, i) => path.join(dir, `db${i}.sqlite`));
  for (const f of dbs) createDb(f, 7, standardFixture());
  return dbs;
}

function crashAt(point: string, whenDbIndex: number | null = null): AdvanceHooks {
  return {
    atPoint(p, ctx) {
      if (p === point && (whenDbIndex === null || ctx.dbIndex === whenDbIndex)) {
        throw new SimulatedCrash(`${p}@${ctx.dbIndex}`);
      }
    },
  };
}

function expectMigratedOnce(file: string): void {
  const dump = dumpDb(file);
  assert.equal(dump.userVersion, 8);
  const items = dump.tables["items"] as { name: string; qty: number }[];
  assert.deepEqual(items.map((r) => [r.name, r.qty]), [
    ["apple", 11],
    ["cherry", 4],
  ]);
  const logs = dump.tables["log_entries"] as { note: string }[];
  assert.deepEqual(logs.map((r) => r.note), ["seed", "migrated"]);
  assert.deepEqual(dump.sequences, [
    { name: "items", seq: 3 },
    { name: "log_entries", seq: 2 },
  ]);
}

test("crash after canary commit but before recording: resume finishes without re-applying", () => {
  const dir = mkTmpDir();
  const dbs = setup(dir, 3);
  const statePath = path.join(dir, "state.sqlite");

  const m1 = new CanaryMigrator(statePath);
  m1.submit({ id: "b1", dbs, startVersion: 7, sql: CUMULATIVE_SQL });
  assert.throws(() => m1.advance("b1", crashAt("afterDbCommit", 0)), SimulatedCrash);
  // 不 close，模拟进程被杀

  // 现场：金丝雀已真实提交，但协调器只记到 backed_up
  const mid = new CanaryMigrator(statePath);
  const midProgress = mid.query("b1")!;
  assert.equal(midProgress.status, "publishing");
  assert.equal(midProgress.dbs[0]!.state, "backed_up");
  assert.equal(dumpDb(dbs[0]!).userVersion, 8);

  const result = mid.advance("b1");
  assert.equal(result.status, "success");
  for (const f of dbs) expectMigratedOnce(f);
  mid.close();
});

test("crash after all dbs committed but before terminal success: resume only marks success", () => {
  const dir = mkTmpDir();
  const dbs = setup(dir, 2);
  const statePath = path.join(dir, "state.sqlite");

  const m1 = new CanaryMigrator(statePath);
  m1.submit({ id: "b1", dbs, startVersion: 7, sql: CUMULATIVE_SQL });
  assert.throws(() => m1.advance("b1", crashAt("beforeMarkSuccess")), SimulatedCrash);

  const m2 = new CanaryMigrator(statePath);
  assert.equal(m2.query("b1")!.status, "publishing");
  const result = m2.advance("b1");
  assert.equal(result.status, "success");
  for (const f of dbs) expectMigratedOnce(f);
  m2.close();
});

test("crash mid-rollback: resume completes rollback to failed, all dbs restored", () => {
  const dir = mkTmpDir();
  const dbs = setup(dir, 3);
  // 最后一个库制造唯一索引冲突
  createDb(dbs[2]!, 7, ["INSERT INTO items(name, qty) VALUES ('apple', 99)"]);
  const before = dbs.map(dumpDb);
  const statePath = path.join(dir, "state.sqlite");
  const sql = CUMULATIVE_SQL + "CREATE UNIQUE INDEX ux_items_name ON items(name);";

  const m1 = new CanaryMigrator(statePath);
  m1.submit({ id: "b1", dbs, startVersion: 7, sql });
  // 第一次恢复完成（db1 已还原）后被杀
  assert.throws(() => m1.advance("b1", crashAt("afterRestore", 1)), SimulatedCrash);

  const m2 = new CanaryMigrator(statePath);
  const mid = m2.query("b1")!;
  assert.equal(mid.status, "rolling_back");
  assert.deepEqual(mid.dbs.map((d) => d.state), ["migrated", "rolled_back", "backed_up"]);

  const result = m2.advance("b1");
  assert.equal(result.status, "failed");
  for (let i = 0; i < dbs.length; i++) {
    assert.deepEqual(dumpDb(dbs[i]!), before[i]!, `db${i} fully restored`);
  }
  m2.close();
});

test("recovery itself crashed again: second resume converges", () => {
  const dir = mkTmpDir();
  const dbs = setup(dir, 3);
  const statePath = path.join(dir, "state.sqlite");

  const m1 = new CanaryMigrator(statePath);
  m1.submit({ id: "b1", dbs, startVersion: 7, sql: CUMULATIVE_SQL });
  assert.throws(() => m1.advance("b1", crashAt("afterDbCommit", 1)), SimulatedCrash);

  // 第一次恢复：又在记录 db2 时被杀
  const m2 = new CanaryMigrator(statePath);
  assert.throws(() => m2.advance("b1", crashAt("afterDbRecorded", 2)), SimulatedCrash);

  // 第二次恢复：收敛到成功
  const m3 = new CanaryMigrator(statePath);
  const result = m3.advance("b1");
  assert.equal(result.status, "success");
  for (const f of dbs) expectMigratedOnce(f);
  m3.close();
});

test("query distinguishes publishing and rolling_back mid-flight", () => {
  const dir = mkTmpDir();
  const dbs = setup(dir, 2);
  createDb(dbs[1]!, 7, ["INSERT INTO items(name, qty) VALUES ('apple', 99)"]);
  const statePath = path.join(dir, "state.sqlite");
  const sql = CUMULATIVE_SQL + "CREATE UNIQUE INDEX ux_items_name ON items(name);";

  const m1 = new CanaryMigrator(statePath);
  m1.submit({ id: "b1", dbs, startVersion: 7, sql });
  assert.throws(() => m1.advance("b1", crashAt("afterDbRecorded", 0)), SimulatedCrash);
  assert.equal(new CanaryMigrator(statePath).query("b1")!.status, "publishing");

  // 继续推进：db1 失败 -> 进入撤回，在标记 failed 前被杀
  const m2 = new CanaryMigrator(statePath);
  assert.throws(() => m2.advance("b1", crashAt("beforeMarkFailed")), SimulatedCrash);
  const m3 = new CanaryMigrator(statePath);
  assert.equal(m3.query("b1")!.status, "rolling_back");

  const result = m3.advance("b1");
  assert.equal(result.status, "failed");
  m3.close();
});

test("crash after backup but before commit: resume re-runs migration on clean db", () => {
  const dir = mkTmpDir();
  const dbs = setup(dir, 2);
  const statePath = path.join(dir, "state.sqlite");

  const m1 = new CanaryMigrator(statePath);
  m1.submit({ id: "b1", dbs, startVersion: 7, sql: CUMULATIVE_SQL });
  assert.throws(() => m1.advance("b1", crashAt("afterDbBackup", 0)), SimulatedCrash);

  // 现场：快照已落盘、状态 backed_up，业务库仍是起始版本
  const m2 = new CanaryMigrator(statePath);
  assert.equal(m2.query("b1")!.dbs[0]!.state, "backed_up");
  assert.equal(dumpDb(dbs[0]!).userVersion, 7);

  const result = m2.advance("b1");
  assert.equal(result.status, "success");
  for (const f of dbs) expectMigratedOnce(f);
  m2.close();
});
