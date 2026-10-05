import test from "node:test";
import assert from "node:assert/strict";
import { ProfileStore } from "../src/index.ts";
import type { SourceRecord } from "../src/index.ts";
import { Oracle, assertStoreMatchesOracle, profileShape } from "./helpers.ts";

/** 可复现的伪随机数生成器。 */
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomRecord(rand: () => number, recordIndex: number): SourceRecord {
  const sourceId = `src-${recordIndex % 4}`;
  const recordId = `rec-${recordIndex}`;
  const record: SourceRecord = { sourceId, recordId };
  // 标识池刻意放小，让匹配、合并、拆分频繁发生。
  if (rand() < 0.7) record.email = `e${Math.floor(rand() * 12)}@x.com`;
  if (rand() < 0.5) record.externalId = `x-${Math.floor(rand() * 10)}`;
  const tagCount = Math.floor(rand() * 3);
  const tags: string[] = [];
  for (let i = 0; i < tagCount; i += 1) tags.push(`tag-${Math.floor(rand() * 8)}`);
  record.tags = tags;
  record.interactions = Math.floor(rand() * 20);
  return record;
}

for (const seed of [1, 7, 42, 2026]) {
  test(`随机小规模序列与独立重算一致 (seed=${seed})`, () => {
    const rand = mulberry32(seed);
    const store = new ProfileStore();
    const oracle = new Oracle();
    const recordCount = 60;
    const batches = 40;

    for (let batchIndex = 0; batchIndex < batches; batchIndex += 1) {
      const batchSize = 1 + Math.floor(rand() * 8);
      const batch: SourceRecord[] = [];
      const seen = new Set<number>();
      while (batch.length < batchSize) {
        const recordIndex = Math.floor(rand() * recordCount);
        if (seen.has(recordIndex)) continue;
        seen.add(recordIndex);
        batch.push(randomRecord(rand, recordIndex));
      }
      store.submitBatch(batch);
      oracle.applyBatch(batch);
      assertStoreMatchesOracle(store, oracle);
    }
  });
}

test("重复提交与调整批内顺序得到相同结果", () => {
  const rand = mulberry32(99);
  const batches: SourceRecord[][] = [];
  for (let i = 0; i < 15; i += 1) {
    const batch: SourceRecord[] = [];
    const seen = new Set<number>();
    while (batch.length < 6) {
      const recordIndex = Math.floor(rand() * 30);
      if (seen.has(recordIndex)) continue;
      seen.add(recordIndex);
      batch.push(randomRecord(rand, recordIndex));
    }
    batches.push(batch);
  }

  const baseline = new ProfileStore();
  const shuffled = new ProfileStore();
  for (const batch of batches) {
    baseline.submitBatch(batch);
    baseline.submitBatch(batch); // 重复提交相同快照
    shuffled.submitBatch([...batch].reverse());
  }

  assert.equal(baseline.profileCount, shuffled.profileCount);
  for (const batch of batches) {
    for (const record of batch) {
      const a = baseline.getProfileByRecord(record.sourceId, record.recordId);
      const b = shuffled.getProfileByRecord(record.sourceId, record.recordId);
      assert.ok(a && b);
      assert.deepEqual(profileShape(a), profileShape(b));
    }
  }
});
