import { test } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { IdentityStore, MAX_BATCH_SIZE } from "../../src/index.js";
import type { SourceRecord } from "../../src/index.js";

const TOTAL = 100_000;
const GROUP_SIZE = 10;
const GROUPS = TOTAL / GROUP_SIZE;
const CORRECTIONS = 5_000;
const MIB = 1024 * 1024;

test("10万条小档案负载：5000次单记录纠错+查询合计 < 5s", () => {
  const store = new IdentityStore();

  // 每 10 条记录共享一个 email，构成一个档案（共 1 万个档案）
  for (let offset = 0; offset < TOTAL; offset += MAX_BATCH_SIZE) {
    const batch: SourceRecord[] = [];
    for (let i = offset; i < offset + MAX_BATCH_SIZE; i++) {
      const group = Math.floor(i / GROUP_SIZE);
      batch.push({
        sourceId: `s${i % 10}`,
        recordId: `r${i}`,
        email: `group-${group}@x.com`,
        tags: [`tag${i % 50}`, `tag${(i + 7) % 50}`],
        interactions: i % 5,
      });
    }
    store.submitBatch(batch);
  }
  assert.equal(store.profileCount, GROUPS);

  const start = performance.now();
  for (let c = 0; c < CORRECTIONS; c++) {
    // 每次纠错：把某组首条记录的 email 改到相邻组（误填纠正）
    const sourceGroup = c % GROUPS;
    const targetGroup = (c + 1) % GROUPS;
    const recordIndex = sourceGroup * GROUP_SIZE;
    const key = { sourceId: `s${recordIndex % 10}`, recordId: `r${recordIndex}` };
    store.submitBatch([
      {
        ...key,
        email: `group-${targetGroup}@x.com`,
        tags: [`tag${recordIndex % 50}`, `tag${(recordIndex + 7) % 50}`],
        interactions: recordIndex % 5,
      },
    ]);
    // 每次纠错后立即查询，结果必须反映最新提交
    const profile = store.getProfileOf(key)!;
    const memberIds = [...profile.members].map(
      (m) => `${m.sourceId}/${m.recordId}`,
    );
    const targetFirst = targetGroup * GROUP_SIZE;
    assert.ok(
      memberIds.includes(`s${targetFirst % 10}/r${targetFirst}`),
      "query must reflect the latest submit",
    );
    assert.ok(profile.members.size <= GROUP_SIZE + 1);
  }
  const elapsedMs = performance.now() - start;

  const peakMiB = process.memoryUsage().rss / MIB;
  console.log(
    `  [perf] ${CORRECTIONS} corrections+queries: ${elapsedMs.toFixed(0)}ms; peak RSS: ${peakMiB.toFixed(0)}MiB`,
  );
  assert.ok(elapsedMs < 5_000, `corrections took ${elapsedMs}ms`);
  assert.ok(peakMiB < 512, `peak RSS ${peakMiB}MiB`);
});
