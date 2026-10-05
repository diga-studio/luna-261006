import test from "node:test";
import assert from "node:assert/strict";
import { ProfileStore } from "../src/index.ts";
import type { SourceRecord } from "../src/index.ts";

const MIB = 1024 * 1024;
const MEMORY_LIMIT_MIB = 512;

class Meter {
  peakRss = 0;
  sample(): void {
    const { rss } = process.memoryUsage();
    if (rss > this.peakRss) this.peakRss = rss;
  }
  report(label: string, start: number): number {
    this.sample();
    const elapsed = performance.now() - start;
    console.log(
      `    [perf] ${label}: ${elapsed.toFixed(0)}ms, 峰值内存 ${(this.peakRss / MIB).toFixed(1)} MiB`,
    );
    return elapsed;
  }
}

test("规模测试一：10 万条记录共享同一标识", { timeout: 120_000 }, () => {
  const meter = new Meter();
  const store = new ProfileStore();
  const total = 100_000;
  const batchSize = 5000;

  let start = performance.now();
  for (let offset = 0; offset < total; offset += batchSize) {
    const batch: SourceRecord[] = [];
    for (let i = offset; i < offset + batchSize; i += 1) {
      batch.push({
        sourceId: `src-${i % 10}`,
        recordId: `rec-${i}`,
        email: "shared@x.com",
        tags: [`tag-a-${i}`, `tag-b-${i}`],
        interactions: 1,
      });
    }
    store.submitBatch(batch);
    meter.sample();
  }
  const importMs = meter.report(`10 万条共享标识分批首次导入（${total / batchSize} 批）`, start);
  assert.ok(importMs < 15_000, `首次导入耗时 ${importMs.toFixed(0)}ms 超过 15s`);

  const merged = store.getProfileByRecord("src-0", "rec-0");
  assert.ok(merged);
  assert.equal(merged.members.length, total);
  assert.equal(merged.interactions, total);

  // 将其中一条改为无标识：巨型档案必须拆成 99999 + 1。
  start = performance.now();
  store.submitBatch([
    {
      sourceId: "src-0",
      recordId: "rec-0",
      tags: ["tag-a-0", "tag-b-0"],
      interactions: 1,
    },
  ]);
  const detached = store.getProfileByRecord("src-0", "rec-0");
  const rest = store.getProfileByRecord("src-1", "rec-1");
  const splitMs = meter.report("单条撤回标识并查询拆分后的两个档案", start);
  assert.ok(splitMs < 5_000, `拆分更新与查询耗时 ${splitMs.toFixed(0)}ms 超过 5s`);

  assert.ok(detached && rest);
  assert.notEqual(detached.profileId, rest.profileId);
  assert.equal(detached.members.length, 1);
  assert.equal(rest.members.length, total - 1);
  assert.equal(rest.interactions, total - 1);
  assert.equal(store.profileCount, 2);

  assert.ok(
    meter.peakRss < MEMORY_LIMIT_MIB * MIB,
    `峰值内存 ${(meter.peakRss / MIB).toFixed(1)} MiB 超过 ${MEMORY_LIMIT_MIB} MiB`,
  );
});

test("规模测试二：10 万条记录、档案至多 20 条，连续 5000 次单记录纠错", { timeout: 120_000 }, () => {
  const meter = new Meter();
  const store = new ProfileStore();
  const groupCount = 5000;
  const groupSize = 20;
  const total = groupCount * groupSize;

  // 首次导入：每组 20 条记录共享一个 email。
  const pending: SourceRecord[] = [];
  for (let g = 0; g < groupCount; g += 1) {
    for (let m = 0; m < groupSize; m += 1) {
      pending.push({
        sourceId: `src-${g % 25}`,
        recordId: `g${g}-m${m}`,
        email: `group-${g}@x.com`,
        tags: [`tag-a-${g}-${m}`, `tag-b-${g}-${m}`],
        interactions: m + 1,
      });
    }
  }
  for (let offset = 0; offset < pending.length; offset += 5000) {
    store.submitBatch(pending.slice(offset, offset + 5000));
  }
  meter.sample();
  assert.equal(store.recordCount, total);
  assert.equal(store.profileCount, groupCount);

  // 连续 5000 次纠错：每次把某组的一条记录改为全新的独立标识，
  // 变更前后涉及的档案合计 19 + 1 = 20 条记录。
  const start = performance.now();
  for (let g = 0; g < groupCount; g += 1) {
    store.submitBatch([
      {
        sourceId: `src-${g % 25}`,
        recordId: `g${g}-m0`,
        email: `corrected-${g}@x.com`,
        tags: [`tag-a-${g}-0`, `tag-b-${g}-0`],
        interactions: 1,
      },
    ]);
    const profile = store.getProfileByRecord(`src-${g % 25}`, `g${g}-m0`);
    assert.ok(profile);
    assert.equal(profile.members.length, 1, `第 ${g} 次纠错后该记录应独立成档`);
  }
  const correctionsMs = meter.report("5000 次单记录纠错 + 每次纠错后查询", start);
  assert.ok(correctionsMs < 5_000, `连续纠错耗时 ${correctionsMs.toFixed(0)}ms 超过 5s`);

  // 纠错后：每组剩 19 条，外加 5000 个单记录档案。
  assert.equal(store.profileCount, groupCount * 2);
  const shrunk = store.getProfileByRecord("src-0", "g0-m1");
  assert.ok(shrunk);
  assert.equal(shrunk.members.length, groupSize - 1);

  assert.ok(
    meter.peakRss < MEMORY_LIMIT_MIB * MIB,
    `峰值内存 ${(meter.peakRss / MIB).toFixed(1)} MiB 超过 ${MEMORY_LIMIT_MIB} MiB`,
  );
});
