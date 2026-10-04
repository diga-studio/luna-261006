import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { makeTmpDir, writeCsv, generateRecords } from "./helpers.js";
import { createImporter } from "../src/index.js";
import { setReadObserver } from "../src/csv.js";

test("恢复时不重扫已完成前缀（记录实际源文件读取范围）", () => {
  const dir = makeTmpDir("noscan");
  // 500 条约 2KiB 的记录，文件约 1MiB
  const records = generateRecords(500).map((r) => ({
    ...r,
    description: r.description + "d".repeat(2048),
  }));
  const csvPath = writeCsv(dir, "deep.csv", records);
  const dbPath = path.join(dir, "db.sqlite");

  const imp = createImporter(dbPath);
  const id = imp.createImport(csvPath);
  // 先完成两批（256 条），使恢复点位于文件深处
  imp.advanceImport(id);
  imp.advanceImport(id);
  imp.close();

  const db = new DatabaseSync(dbPath);
  const task = db.prepare("SELECT offset, completed FROM tasks WHERE id = ?").get(id) as {
    offset: number;
    completed: number;
  };
  db.close();
  assert.strictEqual(task.completed, 256);
  assert.ok(task.offset > 500 * 1024, `恢复点应位于文件深处，实际 offset=${task.offset}`);

  // 记录后续解析器对源文件的实际读取范围
  const reads: Array<{ position: number; length: number }> = [];
  setReadObserver((position, length) => reads.push({ position, length }));
  try {
    const imp2 = createImporter(dbPath);
    const res = imp2.advanceImport(id);
    imp2.close();
    assert.strictEqual(res.processed, 128);
  } finally {
    setReadObserver(null);
  }

  assert.ok(reads.length > 0, "应当确实读取了源文件");
  const minPos = Math.min(...reads.map((r) => r.position));
  // 所有读取都不得触及已完成前缀（offset 之前的字节）
  assert.ok(minPos >= task.offset, `回读了已完成前缀：min=${minPos} < offset=${task.offset}`);
  // 且第一次读取恰好从恢复点开始（0 字节重扫）
  assert.strictEqual(minPos, task.offset);
  const prefixBytes = reads.filter((r) => r.position < task.offset).reduce((a, r) => a + r.length, 0);
  assert.ok(prefixBytes <= 64 * 1024, `回读已完成前缀 ${prefixBytes} 字节，超过 64KiB`);
});
