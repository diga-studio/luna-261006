import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as path from "path";
import { CanaryMigrator } from "../src/index";
import { CUMULATIVE_SQL, createDb, dumpDb, mkTmpDir, standardFixture } from "./helpers";

test("happy path: canary first, then followers, all exactly once", () => {
  const dir = mkTmpDir();
  const dbs = [0, 1, 2].map((i) => path.join(dir, `db${i}.sqlite`));
  for (const f of dbs) createDb(f, 7, standardFixture());
  const before = dbs.map(dumpDb);

  const m = new CanaryMigrator(path.join(dir, "state.sqlite"));
  const submitted = m.submit({ id: "b1", dbs, startVersion: 7, sql: CUMULATIVE_SQL });
  assert.equal(submitted.status, "publishing");

  const result = m.advance("b1");
  assert.equal(result.status, "success");

  const progress = m.query("b1")!;
  assert.equal(progress.status, "success");
  assert.deepEqual(progress.dbs.map((d) => d.state), ["migrated", "migrated", "migrated"]);

  // 新连接能读到金丝雀（以及其余库）的新结构、数据与版本
  const m2 = new CanaryMigrator(path.join(dir, "state.sqlite"));
  assert.equal(m2.query("b1")!.status, "success");

  for (let i = 0; i < dbs.length; i++) {
    const after = dumpDb(dbs[i]!);
    assert.equal(after.userVersion, 8, `db${i} version`);
    const items = after.tables["items"] as { name: string; qty: number; code: string | null }[];
    // 累计加值恰好一次；obsolete 行被删除；新列存在
    assert.deepEqual(
      items.map((r) => [r.name, r.qty, r.code]),
      [
        ["apple", 11, null],
        ["cherry", 4, null],
      ]
    );
    const logs = after.tables["log_entries"] as { note: string }[];
    assert.deepEqual(logs.map((r) => r.note), ["seed", "migrated"]);
    // 自增进度只前进一次（seed=1, migrated=2）
    assert.deepEqual(after.sequences, [
      { name: "items", seq: 3 },
      { name: "log_entries", seq: 2 },
    ]);
    void before;
  }
  m.close();
  m2.close();
});
