import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as path from "path";
import { CanaryMigrator } from "../src/index";
import { CUMULATIVE_SQL, createDb, dumpDb, mkTmpDir, standardFixture } from "./helpers";

test("resubmitting same id returns original batch without touching files", () => {
  const dir = mkTmpDir();
  const dbs = [0, 1].map((i) => path.join(dir, `db${i}.sqlite`));
  for (const f of dbs) createDb(f, 7, standardFixture());
  const m = new CanaryMigrator(path.join(dir, "state.sqlite"));

  const first = m.submit({ id: "b1", dbs, startVersion: 7, sql: CUMULATIVE_SQL });
  // 同标识不同内容：仍返回原批次，不创建新批次
  const second = m.submit({ id: "b1", dbs: [dbs[0]!], startVersion: 7, sql: "SELECT 1;" });
  assert.deepEqual(second, first);
  assert.equal(m.query("b1")!.dbs.length, 2);
  m.close();
});

test("old batch retry never overwrites a later successful batch", () => {
  const dir = mkTmpDir();
  const dbs = [0, 1].map((i) => path.join(dir, `db${i}.sqlite`));
  for (const f of dbs) createDb(f, 7, standardFixture());
  const statePath = path.join(dir, "state.sqlite");
  const m = new CanaryMigrator(statePath);

  // 批次 A：7 -> 8
  m.submit({ id: "A", dbs, startVersion: 7, sql: CUMULATIVE_SQL });
  assert.equal(m.advance("A").status, "success");

  // 批次 B：8 -> 9，再累计一次
  m.submit({ id: "B", dbs, startVersion: 8, sql: "UPDATE items SET qty = qty + 10;" });
  assert.equal(m.advance("B").status, "success");
  const afterB = dbs.map(dumpDb);

  // 重试旧批次 A：返回原终态记录，且不得修改任何库文件
  const resubmitted = m.submit({ id: "A", dbs, startVersion: 7, sql: CUMULATIVE_SQL });
  assert.equal(resubmitted.status, "success");
  const retried = m.advance("A");
  assert.equal(retried.status, "success");

  for (let i = 0; i < dbs.length; i++) {
    assert.deepEqual(dumpDb(dbs[i]!), afterB[i]!, `db${i} unchanged by old batch retry`);
    assert.equal(dumpDb(dbs[i]!).userVersion, 9);
  }
  const items = dumpDb(dbs[0]!).tables["items"] as { name: string; qty: number }[];
  assert.deepEqual(items.map((r) => [r.name, r.qty]), [
    ["apple", 21],
    ["cherry", 14],
  ]);
  m.close();
});

test("re-advancing a failed batch is a no-op", () => {
  const dir = mkTmpDir();
  const dbs = [0, 1].map((i) => path.join(dir, `db${i}.sqlite`));
  createDb(dbs[0]!, 7, standardFixture());
  createDb(dbs[1]!, 7, standardFixture(["INSERT INTO items(name, qty) VALUES ('apple', 99)"]));
  const before = dbs.map(dumpDb);
  const m = new CanaryMigrator(path.join(dir, "state.sqlite"));

  const sql = CUMULATIVE_SQL + "CREATE UNIQUE INDEX ux_items_name ON items(name);";
  m.submit({ id: "b1", dbs, startVersion: 7, sql });
  assert.equal(m.advance("b1").status, "failed");
  // 终态不可变：重复推进/提交都不再有效果
  assert.equal(m.advance("b1").status, "failed");
  assert.equal(m.submit({ id: "b1", dbs, startVersion: 7, sql }).status, "failed");
  for (let i = 0; i < dbs.length; i++) {
    assert.deepEqual(dumpDb(dbs[i]!), before[i]!, `db${i} still original`);
  }
  m.close();
});

test("submit rejects a new batch while another is active", () => {
  const dir = mkTmpDir();
  const dbs = [0].map((i) => path.join(dir, `db${i}.sqlite`));
  for (const f of dbs) createDb(f, 7, standardFixture());
  const m = new CanaryMigrator(path.join(dir, "state.sqlite"));
  m.submit({ id: "b1", dbs, startVersion: 7, sql: CUMULATIVE_SQL });
  assert.throws(() => m.submit({ id: "b2", dbs, startVersion: 7, sql: CUMULATIVE_SQL }), /still active/);
  m.advance("b1");
  // 终态后允许新批次
  assert.equal(m.submit({ id: "b2", dbs, startVersion: 8, sql: "SELECT 1;" }).status, "publishing");
  m.close();
});

test("submit validates the request shape", () => {
  const dir = mkTmpDir();
  const m = new CanaryMigrator(path.join(dir, "state.sqlite"));
  const db = path.join(dir, "db0.sqlite");
  createDb(db, 7, standardFixture());
  assert.throws(() => m.submit({ id: "", dbs: [db], startVersion: 7, sql: "SELECT 1;" }));
  assert.throws(() => m.submit({ id: "x", dbs: [], startVersion: 7, sql: "SELECT 1;" }));
  assert.throws(() => m.submit({ id: "x", dbs: Array(21).fill(db).map((_, i) => `${db}${i}`), startVersion: 7, sql: "SELECT 1;" }));
  assert.throws(() => m.submit({ id: "x", dbs: [db, db], startVersion: 7, sql: "SELECT 1;" }));
  assert.throws(() => m.submit({ id: "x", dbs: [db], startVersion: -1, sql: "SELECT 1;" }));
  assert.throws(() => m.submit({ id: "x", dbs: [db], startVersion: 7, sql: "  " }));
  assert.equal(m.query("x"), null);
  m.close();
});

test("version mismatch on a follower aborts the batch and rolls back", () => {
  const dir = mkTmpDir();
  const dbs = [0, 1].map((i) => path.join(dir, `db${i}.sqlite`));
  createDb(dbs[0]!, 7, standardFixture());
  createDb(dbs[1]!, 5, standardFixture()); // 不在起始版本
  const before0 = dumpDb(dbs[0]!);
  const before1 = dumpDb(dbs[1]!);
  const m = new CanaryMigrator(path.join(dir, "state.sqlite"));
  m.submit({ id: "b1", dbs, startVersion: 7, sql: CUMULATIVE_SQL });
  const result = m.advance("b1");
  assert.equal(result.status, "failed");
  assert.match(result.error!, /version 5/);
  assert.deepEqual(dumpDb(dbs[0]!), before0);
  assert.deepEqual(dumpDb(dbs[1]!), before1);
  m.close();
});
