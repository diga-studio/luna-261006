import { test } from "node:test";
import assert from "node:assert/strict";
import { IdentityStore } from "../../src/index.js";
import type { RecordKey } from "../../src/index.js";

function memberIds(store: IdentityStore, key: RecordKey): string[] {
  const profile = store.getProfileOf(key);
  assert.ok(profile, "profile should exist");
  return [...profile.members]
    .map((m) => `${m.sourceId}/${m.recordId}`)
    .sort();
}

test("撤回桥接标识导致拆分，标签与互动随记录重新归属", () => {
  const store = new IdentityStore();
  // bridge 记录用 email 把 A 侧与 B 侧（external_id 群）连在一起
  store.submitBatch([
    { sourceId: "a", recordId: "1", email: "shared@x.com", tags: ["tA"], interactions: 1 },
    { sourceId: "b", recordId: "2", email: "shared@x.com", externalId: "E1", tags: ["tB"], interactions: 2 },
    { sourceId: "c", recordId: "3", externalId: "E1", tags: ["tC"], interactions: 4 },
  ]);
  assert.equal(store.profileCount, 1);

  // 纠错：b/2 撤回 email（误填），仅保留 external_id
  store.submitBatch([
    { sourceId: "b", recordId: "2", externalId: "E1", tags: ["tB"], interactions: 2 },
  ]);

  assert.equal(store.profileCount, 2);
  assert.deepEqual(memberIds(store, { sourceId: "a", recordId: "1" }), ["a/1"]);
  assert.deepEqual(memberIds(store, { sourceId: "b", recordId: "2" }), [
    "b/2",
    "c/3",
  ]);
  const pa = store.getProfileOf({ sourceId: "a", recordId: "1" })!;
  assert.deepEqual([...pa.tags], ["tA"]);
  assert.equal(pa.totalInteractions, 1);
  const pb = store.getProfileOf({ sourceId: "c", recordId: "3" })!;
  assert.deepEqual([...pb.tags].sort(), ["tB", "tC"]);
  assert.equal(pb.totalInteractions, 6);
});

test("存在替代路径时不得误拆", () => {
  const store = new IdentityStore();
  // a/1 与 c/3 之间有两条路径：经 b/2 的 email，以及直接的 external_id
  store.submitBatch([
    { sourceId: "a", recordId: "1", email: "x@x.com", externalId: "E9" },
    { sourceId: "b", recordId: "2", email: "x@x.com" },
    { sourceId: "c", recordId: "3", externalId: "E9" },
  ]);
  assert.equal(store.profileCount, 1);

  // 撤回 b/2 的 email，a/1 与 c/3 仍由 external_id 维系
  store.submitBatch([{ sourceId: "b", recordId: "2" }]);

  assert.deepEqual(memberIds(store, { sourceId: "a", recordId: "1" }), [
    "a/1",
    "c/3",
  ]);
  assert.deepEqual(memberIds(store, { sourceId: "b", recordId: "2" }), ["b/2"]);
  assert.equal(store.profileCount, 2);
});

test("旧标识不再参与匹配：新记录使用被撤回的 email 不会并入旧档案", () => {
  const store = new IdentityStore();
  store.submitBatch([
    { sourceId: "a", recordId: "1", email: "old@x.com", externalId: "E1" },
    { sourceId: "b", recordId: "2", email: "old@x.com" },
  ]);
  // 纠错：a/1 的 email 是误填，撤回
  store.submitBatch([{ sourceId: "a", recordId: "1", externalId: "E1" }]);
  // 全新记录使用 old@x.com，只应与仍持有该标识的 b/2 匹配
  store.submitBatch([{ sourceId: "c", recordId: "3", email: "old@x.com" }]);

  assert.deepEqual(memberIds(store, { sourceId: "a", recordId: "1" }), ["a/1"]);
  assert.deepEqual(memberIds(store, { sourceId: "b", recordId: "2" }), [
    "b/2",
    "c/3",
  ]);
});

test("更正 external_id 后，记录整体迁移到新档案", () => {
  const store = new IdentityStore();
  store.submitBatch([
    { sourceId: "a", recordId: "1", externalId: "E1", tags: ["t1"], interactions: 5 },
    { sourceId: "b", recordId: "2", externalId: "E1", tags: ["t2"], interactions: 7 },
    { sourceId: "c", recordId: "3", externalId: "E2", tags: ["t3"], interactions: 11 },
  ]);
  // b/2 的 external_id 纠错为 E2
  store.submitBatch([
    { sourceId: "b", recordId: "2", externalId: "E2", tags: ["t2"], interactions: 7 },
  ]);

  assert.deepEqual(memberIds(store, { sourceId: "a", recordId: "1" }), ["a/1"]);
  assert.deepEqual(memberIds(store, { sourceId: "b", recordId: "2" }), [
    "b/2",
    "c/3",
  ]);
  const moved = store.getProfileOf({ sourceId: "b", recordId: "2" })!;
  assert.deepEqual([...moved.tags].sort(), ["t2", "t3"]);
  assert.equal(moved.totalInteractions, 18);
  const left = store.getProfileOf({ sourceId: "a", recordId: "1" })!;
  assert.deepEqual([...left.tags], ["t1"]);
  assert.equal(left.totalInteractions, 5);
});
