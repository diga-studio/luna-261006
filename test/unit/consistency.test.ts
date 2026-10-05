import { test } from "node:test";
import assert from "node:assert/strict";
import { IdentityStore } from "../../src/index.js";
import type { RecordKey, SourceRecord } from "../../src/index.js";

/** 可复现的伪随机数生成器。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface ExpectedProfile {
  members: Set<string>;
  tags: Set<string>;
  totalInteractions: number;
}

/** 仅依据当前来源快照独立重算连通群（测试参照实现）。 */
function recomputeFromSnapshot(
  snapshot: ReadonlyMap<string, SourceRecord>,
): Map<string, ExpectedProfile> {
  const records = [...snapshot.values()];
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    let root = k;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cur = k;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (a: string, b: string): void => {
    parent.set(find(a), find(b));
  };
  const keyOf = (r: SourceRecord): string => `${r.sourceId}/${r.recordId}`;
  for (const r of records) parent.set(keyOf(r), keyOf(r));

  const byEmail = new Map<string, string[]>();
  const byExternal = new Map<string, string[]>();
  for (const r of records) {
    if (r.email !== undefined) {
      const list = byEmail.get(r.email) ?? [];
      list.push(keyOf(r));
      byEmail.set(r.email, list);
    }
    if (r.externalId !== undefined) {
      const list = byExternal.get(r.externalId) ?? [];
      list.push(keyOf(r));
      byExternal.set(r.externalId, list);
    }
  }
  for (const group of [byEmail, byExternal]) {
    for (const keys of group.values()) {
      for (let i = 1; i < keys.length; i++) union(keys[0], keys[i]);
    }
  }

  const result = new Map<string, ExpectedProfile>();
  for (const r of records) {
    const root = find(keyOf(r));
    let profile = result.get(root);
    if (!profile) {
      profile = { members: new Set(), tags: new Set(), totalInteractions: 0 };
      result.set(root, profile);
    }
    profile.members.add(keyOf(r));
    for (const tag of r.tags ?? []) profile.tags.add(tag);
    profile.totalInteractions += r.interactions ?? 0;
  }
  return result;
}

function assertStoreMatchesSnapshot(
  store: IdentityStore,
  snapshot: ReadonlyMap<string, SourceRecord>,
): void {
  const expected = recomputeFromSnapshot(snapshot);
  const seenRoots = new Set<string>();
  for (const [keyStr] of snapshot) {
    const slash = keyStr.indexOf("/");
    const key: RecordKey = {
      sourceId: keyStr.slice(0, slash),
      recordId: keyStr.slice(slash + 1),
    };
    const actual = store.getProfileOf(key);
    assert.ok(actual, `profile missing for ${keyStr}`);
    const root = [...expected.entries()].find(([, p]) => p.members.has(keyStr))![0];
    if (seenRoots.has(root)) continue;
    seenRoots.add(root);
    const want = expected.get(root)!;
    assert.deepEqual(
      [...actual.members].map((m) => `${m.sourceId}/${m.recordId}`).sort(),
      [...want.members].sort(),
      `members mismatch for component of ${keyStr}`,
    );
    assert.deepEqual(
      [...actual.tags].sort(),
      [...want.tags].sort(),
      `tags mismatch for component of ${keyStr}`,
    );
    assert.equal(
      actual.totalInteractions,
      want.totalInteractions,
      `interactions mismatch for component of ${keyStr}`,
    );
  }
  assert.equal(store.profileCount, expected.size, "profile count mismatch");
}

function runFuzz(seed: number, rounds: number): void {
  const rand = mulberry32(seed);
  const store = new IdentityStore();
  const snapshot = new Map<string, SourceRecord>();
  const emails = Array.from({ length: 12 }, (_, i) => `e${i}@x.com`);
  const externals = Array.from({ length: 12 }, (_, i) => `E${i}`);
  const tags = Array.from({ length: 10 }, (_, i) => `tag${i}`);
  const recordCount = 40;

  const makeRecord = (i: number): SourceRecord => {
    const roll = rand();
    const rec: SourceRecord = {
      sourceId: `s${i % 4}`,
      recordId: `r${Math.floor(i / 4)}`,
      tags: [tags[Math.floor(rand() * tags.length)]],
      interactions: Math.floor(rand() * 20),
    };
    if (roll < 0.4) rec.email = emails[Math.floor(rand() * emails.length)];
    else if (roll < 0.8) rec.externalId = externals[Math.floor(rand() * externals.length)];
    else {
      rec.email = emails[Math.floor(rand() * emails.length)];
      rec.externalId = externals[Math.floor(rand() * externals.length)];
    }
    if (rand() < 0.15) {
      delete rec.email;
      delete rec.externalId;
    }
    if (rand() < 0.5) rec.tags = [...rec.tags!, tags[Math.floor(rand() * tags.length)]];
    return rec;
  };

  for (let round = 0; round < rounds; round++) {
    const batchSize = 1 + Math.floor(rand() * 8);
    const batch: SourceRecord[] = [];
    const used = new Set<string>();
    while (batch.length < batchSize) {
      const i = Math.floor(rand() * recordCount);
      const rec = makeRecord(i);
      const key = `${rec.sourceId}/${rec.recordId}`;
      if (used.has(key)) continue;
      used.add(key);
      batch.push(rec);
    }
    // 随机打乱批内顺序
    for (let i = batch.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [batch[i], batch[j]] = [batch[j], batch[i]];
    }
    store.submitBatch(batch);
    for (const rec of batch) {
      snapshot.set(`${rec.sourceId}/${rec.recordId}`, rec);
    }
    // 偶尔重复提交同一快照（不得改变结果）
    if (rand() < 0.2) {
      store.submitBatch(batch);
    }
    assertStoreMatchesSnapshot(store, snapshot);
  }
}

test("随机增删改后，档案始终与当前快照独立重算一致", () => {
  runFuzz(42, 60);
  runFuzz(7, 60);
  runFuzz(20261005, 60);
});
