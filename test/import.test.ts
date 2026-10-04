import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import {
  makeTmpDir,
  writeMixedCsv,
  writeCsv,
  generateRecords,
  buildReference,
  drainImport,
  collectResults,
  getAllCases,
  assertMatchesReference,
} from "./helpers.js";
import { createImporter } from "../src/index.js";

test("组合文件：重开库推进与连续推进结果一致，且与参考模型一致", () => {
  const dir = makeTmpDir("mixed");
  const { csvPath, records } = writeMixedCsv(dir);
  const ref = buildReference(records);

  // 连续推进（单实例）
  const dbA = path.join(dir, "a.sqlite");
  const impA = createImporter(dbA);
  const idA = impA.createImport(csvPath);
  impA.close();
  drainImport(dbA, idA, false);
  assertMatchesReference(dbA, idA, ref, assert);

  // 每次推进都关闭并重开库
  const dbB = path.join(dir, "b.sqlite");
  const impB = createImporter(dbB);
  const idB = impB.createImport(csvPath);
  impB.close();
  drainImport(dbB, idB, true);
  assertMatchesReference(dbB, idB, ref, assert);

  // 两个数据库逐行结果完全一致
  assert.deepStrictEqual(collectResults(dbA, idA), collectResults(dbB, idB));
});

test("多批次文件（300 条，跨 3 批）", () => {
  const dir = makeTmpDir("multi");
  const records = generateRecords(300);
  const csvPath = writeCsv(dir, "big.csv", records, false);
  const ref = buildReference(records);

  const dbPath = path.join(dir, "db.sqlite");
  const imp = createImporter(dbPath);
  const id = imp.createImport(csvPath);
  imp.close();
  drainImport(dbPath, id, true);
  assertMatchesReference(dbPath, id, ref, assert);

  const inspect = collectResults(dbPath, id);
  assert.strictEqual(inspect.done, true);
  // 记录号连续且从 1 开始
  inspect.results.forEach((r, i) => assert.strictEqual(r.recordNo, i + 1));
});

test("已完成任务再次推进不产生变化", () => {
  const dir = makeTmpDir("done");
  const records = generateRecords(10);
  const csvPath = writeCsv(dir, "t.csv", records);
  const dbPath = path.join(dir, "db.sqlite");
  const imp = createImporter(dbPath);
  const id = imp.createImport(csvPath);
  imp.close();
  drainImport(dbPath, id, false);
  const before = collectResults(dbPath, id);

  const imp2 = createImporter(dbPath);
  const res = imp2.advanceImport(id);
  imp2.close();
  assert.strictEqual(res.processed, 0);
  assert.strictEqual(res.done, true);
  assert.deepStrictEqual(collectResults(dbPath, id), before);
});

test("getCase 不存在返回 null；revision 随成功行递增", () => {
  const dir = makeTmpDir("case");
  const records = [
    { externalId: "X", category: "fraud", description: "a" },
    { externalId: "X", category: "fraud", description: "a" }, // 内容相同也 +1
    { externalId: "X", category: "other", description: "b" },
    { externalId: "Y", category: "bogus", description: "失败不增 revision" },
    { externalId: "Y", category: "other", description: "y" },
  ];
  const csvPath = writeCsv(dir, "t.csv", records);
  const dbPath = path.join(dir, "db.sqlite");
  const imp = createImporter(dbPath);
  const id = imp.createImport(csvPath);
  imp.close();
  drainImport(dbPath, id, false);

  const cases = getAllCases(dbPath, ["X", "Y", "Z"]);
  assert.deepStrictEqual(cases.get("X"), { externalId: "X", category: "other", description: "b", revision: 3 });
  assert.deepStrictEqual(cases.get("Y"), { externalId: "Y", category: "other", description: "y", revision: 1 });
  assert.strictEqual(cases.get("Z"), null);

  const inspect = collectResults(dbPath, id);
  assert.deepStrictEqual(
    inspect.results.map((r) => r.revision),
    [1, 2, 3, null, 1]
  );
});

test("inspectImport 的 after/limit 分页", () => {
  const dir = makeTmpDir("page");
  const records = generateRecords(20);
  const csvPath = writeCsv(dir, "t.csv", records);
  const dbPath = path.join(dir, "db.sqlite");
  const imp = createImporter(dbPath);
  const id = imp.createImport(csvPath);
  imp.close();
  drainImport(dbPath, id, false);

  const imp2 = createImporter(dbPath);
  const page = imp2.inspectImport(id, 5, 3);
  imp2.close();
  assert.deepStrictEqual(page.results.map((r) => r.recordNo), [6, 7, 8]);
  assert.strictEqual(page.completed, 20);
});

test("字段值不做归一化（保留原始空白与大小写）", () => {
  const dir = makeTmpDir("raw");
  const records = [
    { externalId: "  spaced  ", category: "other", description: "  keep\tspaces  " },
    { externalId: "CaseSensitive", category: "other", description: "Mixed CASE" },
  ];
  const csvPath = writeCsv(dir, "t.csv", records);
  const dbPath = path.join(dir, "db.sqlite");
  const imp = createImporter(dbPath);
  const id = imp.createImport(csvPath);
  imp.close();
  drainImport(dbPath, id, false);
  const cases = getAllCases(dbPath, ["  spaced  ", "CaseSensitive"]);
  assert.strictEqual(cases.get("  spaced  ")!.description, "  keep\tspaces  ");
  assert.strictEqual(cases.get("CaseSensitive")!.externalId, "CaseSensitive");
});

test("只有表头的文件：立即完成，无记录", () => {
  const dir = makeTmpDir("header-only");
  const csvPath = path.join(dir, "h.csv");
  require("node:fs").writeFileSync(csvPath, "external_id,category,description\n");
  const dbPath = path.join(dir, "db.sqlite");
  const imp = createImporter(dbPath);
  const id = imp.createImport(csvPath);
  const res = imp.advanceImport(id);
  imp.close();
  assert.strictEqual(res.done, true);
  assert.strictEqual(res.completed, 0);
  const inspect = collectResults(dbPath, id);
  assert.strictEqual(inspect.results.length, 0);
});
