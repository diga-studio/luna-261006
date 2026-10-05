import { test } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { IdentityStore, MAX_BATCH_SIZE } from "../../src/index.js";
import type { SourceRecord } from "../../src/index.js";

const TOTAL = 100_000;
const MIB = 1024 * 1024;

function peakRssMiB(): number {
  return process.memoryUsage().rss / MIB;
}

test("10万条记录共享同一标识：分批导入 < 15s，拆分更新+查询 < 5s，内存 < 512MiB", () => {
  const store = new IdentityStore();

  const importStart = performance.now();
  for (let offset = 0; offset < TOTAL; offset += MAX_BATCH_SIZE) {
    const batch: SourceRecord[] = [];
    for (let i = offset; i < offset + MAX_BATCH_SIZE; i++) {
      batch.push({
        sourceId: `s${i % 10}`,
        recordId: `r${i}`,
        email: "shared@x.com",
        tags: [`tag${i % 100}`, `tag${(i + 1) % 100}`],
        interactions: 1,
      });
    }
    store.submitBatch(batch);
  }
  const importMs = performance.now() - importStart;

  const whole = store.getProfileOf({ sourceId: "s0", recordId: "r0" })!;
  assert.equal(whole.members.size, TOTAL);
  assert.equal(whole.totalInteractions, TOTAL);
  assert.equal(whole.tags.size, 100);

  // 将其中一条改为无标识，触发拆分
  const splitStart = performance.now();
  store.submitBatch([
    {
      sourceId: "s5",
      recordId: "r12345",
      tags: [`tag${12345 % 100}`, `tag${12346 % 100}`],
      interactions: 1,
    },
  ]);
  const detached = store.getProfileOf({ sourceId: "s5", recordId: "r12345" })!;
  const rest = store.getProfileOf({ sourceId: "s0", recordId: "r0" })!;
  const splitMs = performance.now() - splitStart;

  assert.equal(detached.members.size, 1);
  assert.equal(rest.members.size, TOTAL - 1);
  assert.equal(rest.totalInteractions, TOTAL - 1);
  assert.equal(store.profileCount, 2);

  const peakMiB = peakRssMiB();
  console.log(
    `  [perf] import ${TOTAL} records: ${importMs.toFixed(0)}ms; ` +
      `split update+queries: ${splitMs.toFixed(0)}ms; peak RSS: ${peakMiB.toFixed(0)}MiB`,
  );
  assert.ok(importMs < 15_000, `import took ${importMs}ms`);
  assert.ok(splitMs < 5_000, `split took ${splitMs}ms`);
  assert.ok(peakMiB < 512, `peak RSS ${peakMiB}MiB`);
});
