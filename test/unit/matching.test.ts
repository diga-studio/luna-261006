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

test("相同 email 的记录跨 source 合并", () => {
  const store = new IdentityStore();
  store.submitBatch([
    { sourceId: "crm", recordId: "1", email: "a@x.com", tags: ["vip"], interactions: 3 },
    { sourceId: "web", recordId: "9", email: "a@x.com", tags: ["new"], interactions: 2 },
  ]);
  assert.deepEqual(memberIds(store, { sourceId: "crm", recordId: "1" }), [
    "crm/1",
    "web/9",
  ]);
  const profile = store.getProfileOf({ sourceId: "web", recordId: "9" })!;
  assert.deepEqual([...profile.tags].sort(), ["new", "vip"]);
  assert.equal(profile.totalInteractions, 5);
});

test("相同 external_id 合并，且匹配具有传递性", () => {
  const store = new IdentityStore();
  store.submitBatch([
    { sourceId: "a", recordId: "1", email: "x@x.com" },
    { sourceId: "b", recordId: "2", email: "x@x.com", externalId: "E1" },
    { sourceId: "c", recordId: "3", externalId: "E1" },
  ]);
  assert.deepEqual(memberIds(store, { sourceId: "a", recordId: "1" }), [
    "a/1",
    "b/2",
    "c/3",
  ]);
});

test("email 与 external_id 属不同标识域，字符串相同不构成匹配", () => {
  const store = new IdentityStore();
  store.submitBatch([
    { sourceId: "a", recordId: "1", email: "same" },
    { sourceId: "b", recordId: "2", externalId: "same" },
  ]);
  const pa = store.getProfileOf({ sourceId: "a", recordId: "1" })!;
  const pb = store.getProfileOf({ sourceId: "b", recordId: "2" })!;
  assert.equal(pa.members.size, 1);
  assert.equal(pb.members.size, 1);
  assert.notEqual(pa.profileId, pb.profileId);
});

test("两个标识都缺省的记录各自独立", () => {
  const store = new IdentityStore();
  store.submitBatch([
    { sourceId: "a", recordId: "1", tags: ["t"], interactions: 1 },
    { sourceId: "a", recordId: "2", tags: ["t"], interactions: 1 },
  ]);
  assert.equal(store.profileCount, 2);
});

test("一个标识不同不能阻断另一标识的匹配", () => {
  const store = new IdentityStore();
  store.submitBatch([
    { sourceId: "a", recordId: "1", email: "x@x.com", externalId: "E1" },
    { sourceId: "b", recordId: "2", email: "x@x.com", externalId: "E2" },
  ]);
  assert.deepEqual(memberIds(store, { sourceId: "a", recordId: "1" }), [
    "a/1",
    "b/2",
  ]);
});
