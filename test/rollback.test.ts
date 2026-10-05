import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as path from "path";
import { CanaryMigrator } from "../src/index";
import { CUMULATIVE_SQL, createDb, dumpDb, mkTmpDir, standardFixture } from "./helpers";

test("last db violates unique constraint: entire batch rolled back incl. deleted rows, version, autoincrement", () => {
  const dir = mkTmpDir();
  const dbs = [0, 1, 2].map((i) => path.join(dir, `db${i}.sqlite`));
  createDb(dbs[0]!, 7, standardFixture());
  createDb(dbs[1]!, 7, standardFixture());
  // 最后一个库数据不同：name 有重复，唯一索引必然失败
  createDb(dbs[2]!, 7, standardFixture(["INSERT INTO items(name, qty) VALUES ('apple', 99)"]));
  const before = dbs.map(dumpDb);

  const sql = CUMULATIVE_SQL + "CREATE UNIQUE INDEX ux_items_name ON items(name);";
  const m = new CanaryMigrator(path.join(dir, "state.sqlite"));
  m.submit({ id: "b1", dbs, startVersion: 7, sql });
  const result = m.advance("b1");

  assert.equal(result.status, "failed");
  assert.match(result.error!, /db2/);
  const progress = m.query("b1")!;
  assert.equal(progress.status, "failed");
  assert.deepEqual(progress.dbs.map((d) => d.state), ["rolled_back", "rolled_back", "backed_up"]);

  // 全部库的业务数据、结构、自增进度、版本都回到提交前
  for (let i = 0; i < dbs.length; i++) {
    assert.deepEqual(dumpDb(dbs[i]!), before[i]!, `db${i} fully restored`);
  }
  m.close();
});

test("canary itself fails: nothing is published to any db", () => {
  const dir = mkTmpDir();
  const dbs = [0, 1].map((i) => path.join(dir, `db${i}.sqlite`));
  createDb(dbs[0]!, 7, standardFixture(["INSERT INTO items(name, qty) VALUES ('apple', 99)"]));
  createDb(dbs[1]!, 7, standardFixture());
  const before = dbs.map(dumpDb);

  const sql = CUMULATIVE_SQL + "CREATE UNIQUE INDEX ux_items_name ON items(name);";
  const m = new CanaryMigrator(path.join(dir, "state.sqlite"));
  m.submit({ id: "b1", dbs, startVersion: 7, sql });
  const result = m.advance("b1");

  assert.equal(result.status, "failed");
  assert.deepEqual(m.query("b1")!.dbs.map((d) => d.state), ["backed_up", "pending"]);
  for (let i = 0; i < dbs.length; i++) {
    assert.deepEqual(dumpDb(dbs[i]!), before[i]!, `db${i} untouched`);
  }
  m.close();
});

test("foreign key violation in target data triggers full rollback", () => {
  const dir = mkTmpDir();
  const dbs = [0, 1].map((i) => path.join(dir, `db${i}.sqlite`));
  const base = [
    "CREATE TABLE parent(id INTEGER PRIMARY KEY)",
    "CREATE TABLE child(id INTEGER PRIMARY KEY, pid INTEGER REFERENCES parent(id))",
    "INSERT INTO parent(id) VALUES (1)",
  ];
  createDb(dbs[0]!, 7, [...base, "INSERT INTO parent(id) VALUES (2)"]);
  createDb(dbs[1]!, 7, base); // 缺少 parent id=2，迁移插入 child(pid=2) 后外键违规
  const before = dbs.map(dumpDb);

  const m = new CanaryMigrator(path.join(dir, "state.sqlite"));
  m.submit({ id: "b1", dbs, startVersion: 7, sql: "INSERT INTO child(id, pid) VALUES (100, 2);" });
  const result = m.advance("b1");

  assert.equal(result.status, "failed");
  assert.match(result.error!, /foreign key/);
  for (let i = 0; i < dbs.length; i++) {
    assert.deepEqual(dumpDb(dbs[i]!), before[i]!, `db${i} fully restored`);
  }
  m.close();
});
