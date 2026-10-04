import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTmpDir } from "./helpers.js";
import { createImporter } from "../src/index.js";

// 流式处理的内存证明：源文件远大于 192MiB 峰值 RSS 预算中可用于数据的部分，
// 若实现把整文件或全部行结果载入内存，RSS 必然超限。
test("大文件导入峰值 RSS 低于 192 MiB", { timeout: 300000 }, () => {
  const dir = makeTmpDir("mem");
  const csvPath = path.join(dir, "large.csv");
  const recordCount = 2600;
  const description = "d".repeat(60 * 1024); // 每条记录约 60KiB
  const fd = fs.openSync(csvPath, "w");
  for (let i = 1; i <= recordCount; i++) {
    const line = i === 1 ? "external_id,category,description\n" : "";
    fs.writeSync(fd, `${line}CASE-${i},other,${description}\n`);
  }
  fs.closeSync(fd);
  const fileSize = fs.statSync(csvPath).size;
  assert.ok(fileSize > 128 * 1024 * 1024, `文件应大于 128MiB，实际 ${fileSize}`);

  const dbPath = path.join(dir, "db.sqlite");
  const imp = createImporter(dbPath);
  const id = imp.createImport(csvPath);
  let peak = process.memoryUsage().rss;
  for (;;) {
    const res = imp.advanceImport(id);
    peak = Math.max(peak, process.memoryUsage().rss);
    if (res.done) break;
  }
  imp.close();
  peak = Math.max(peak, process.memoryUsage().rss);

  const mib = (n: number) => (n / 1024 / 1024).toFixed(1);
  assert.ok(
    peak < 192 * 1024 * 1024,
    `峰值 RSS ${mib(peak)} MiB 超过 192 MiB（文件 ${mib(fileSize)} MiB）`
  );

  // 结果完整性抽查
  const imp2 = createImporter(dbPath);
  const inspect = imp2.inspectImport(id, 0, 1);
  assert.strictEqual(inspect.completed, recordCount);
  assert.strictEqual(inspect.succeeded, recordCount);
  assert.strictEqual(imp2.getCase(`CASE-${recordCount}`)!.revision, 1);
  imp2.close();
});
