import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import {
  makeTmpDir,
  writeCsv,
  generateRecords,
  buildReference,
  drainImport,
  collectResults,
  assertMatchesReference,
  runChildUntilKilled,
} from "./helpers.js";
import { createImporter } from "../src/index.js";

function setup(recordsCount: number): { dir: string; csvPath: string; dbPath: string; id: number; ref: ReturnType<typeof buildReference> } {
  const dir = makeTmpDir("kill");
  const records = generateRecords(recordsCount);
  const csvPath = writeCsv(dir, "cases.csv", records, false);
  const dbPath = path.join(dir, "db.sqlite");
  const imp = createImporter(dbPath);
  const id = imp.createImport(csvPath);
  imp.close();
  return { dir, csvPath, dbPath, id, ref: buildReference(records) };
}

function assertConsistentPrefix(dbPath: string, id: number, expectedCompleted: number): void {
  const inspect = collectResults(dbPath, id);
  assert.strictEqual(inspect.completed, expectedCompleted, "completed");
  assert.strictEqual(inspect.succeeded + inspect.failed, inspect.completed, "s+f=c");
  assert.strictEqual(inspect.results.length, expectedCompleted, "one result per record");
  inspect.results.forEach((r, i) => assert.strictEqual(r.recordNo, i + 1, "contiguous record numbers"));
}

test("提交前被杀（缓冲区已预读后续记录）：续跑无丢失无重复", async () => {
  // 300 条小记录，全部会被预读进 64KiB 缓冲；在第 50 条提交前杀死。
  const { dbPath, id, ref } = setup(300);
  await runChildUntilKilled(dbPath, id, { HR_IMPORT_PAUSE_BEFORE_COMMIT: "50" });

  // 被杀后：恰好 49 条已提交，构成一致前缀
  assertConsistentPrefix(dbPath, id, 49);

  // 续跑到底，与参考模型逐项一致
  drainImport(dbPath, id, true);
  assertMatchesReference(dbPath, id, ref, assert);
});

test("第 1 条提交前被杀：前缀为空，续跑完整", async () => {
  const { dbPath, id, ref } = setup(50);
  await runChildUntilKilled(dbPath, id, { HR_IMPORT_PAUSE_BEFORE_COMMIT: "1" });
  assertConsistentPrefix(dbPath, id, 0);
  drainImport(dbPath, id, true);
  assertMatchesReference(dbPath, id, ref, assert);
});

test("整批 128 条已提交但未返回时被杀：不重投、计数不漂移", async () => {
  const { dbPath, id, ref } = setup(300);
  await runChildUntilKilled(dbPath, id, { HR_IMPORT_PAUSE_AFTER_COMMIT: "128" });

  // 128 条已持久化
  assertConsistentPrefix(dbPath, id, 128);

  // 续跑：从第 129 条继续，最终结果与顺序导入一致
  drainImport(dbPath, id, true);
  assertMatchesReference(dbPath, id, ref, assert);
  const inspect = collectResults(dbPath, id);
  assert.strictEqual(inspect.results.length, 300, "no duplicated results");
});

test("文件末尾批次提交后、返回前被杀：done 标志已持久化", async () => {
  const { dbPath, id, ref } = setup(60); // 不足一批，提交 done 后暂停
  await runChildUntilKilled(dbPath, id, { HR_IMPORT_PAUSE_BEFORE_RETURN: "1" });

  const inspectAfterKill = collectResults(dbPath, id);
  assert.strictEqual(inspectAfterKill.done, true, "done persisted before kill");
  assertConsistentPrefix(dbPath, id, 60);

  // 已完成任务再次推进不得产生变化
  const imp = createImporter(dbPath);
  const res = imp.advanceImport(id);
  imp.close();
  assert.strictEqual(res.processed, 0);
  assertMatchesReference(dbPath, id, ref, assert);
});

test("反复杀死并续跑直到完成", async () => {
  const { dbPath, id, ref } = setup(400);
  // 第一轮：杀在第 30 条提交前
  await runChildUntilKilled(dbPath, id, { HR_IMPORT_PAUSE_BEFORE_COMMIT: "30" });
  assertConsistentPrefix(dbPath, id, 29);
  // 第二轮：杀在第 100 条提交后（累计 129 条）
  await runChildUntilKilled(dbPath, id, { HR_IMPORT_PAUSE_AFTER_COMMIT: "100" });
  assertConsistentPrefix(dbPath, id, 129);
  // 第三轮：杀在第 128 条提交前（累计 256 条）
  await runChildUntilKilled(dbPath, id, { HR_IMPORT_PAUSE_BEFORE_COMMIT: "128" });
  assertConsistentPrefix(dbPath, id, 256);
  // 续跑到底
  drainImport(dbPath, id, true);
  assertMatchesReference(dbPath, id, ref, assert);
});
