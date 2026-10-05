import { test } from "node:test";
import assert from "node:assert/strict";
import { IdentityStore, MAX_BATCH_SIZE } from "../../src/index.js";
import type { SourceRecord } from "../../src/index.js";

test("单批超过 5000 条被拒绝", () => {
  const store = new IdentityStore();
  const batch: SourceRecord[] = [];
  for (let i = 0; i < MAX_BATCH_SIZE + 1; i++) {
    batch.push({ sourceId: "s", recordId: `r${i}` });
  }
  assert.throws(() => store.submitBatch(batch), RangeError);
});

test("同批重复记录键被拒绝", () => {
  const store = new IdentityStore();
  assert.throws(() =>
    store.submitBatch([
      { sourceId: "s", recordId: "r1", email: "a@x.com" },
      { sourceId: "s", recordId: "r1", email: "b@x.com" },
    ]),
  );
});

test("重复提交相同快照不增加互动次数", () => {
  const store = new IdentityStore();
  const batch: SourceRecord[] = [
    { sourceId: "s", recordId: "r1", email: "a@x.com", interactions: 5 },
    { sourceId: "s", recordId: "r2", email: "a@x.com", interactions: 7 },
  ];
  store.submitBatch(batch);
  store.submitBatch(batch);
  store.submitBatch(batch);
  const profile = store.getProfileOf({ sourceId: "s", recordId: "r1" })!;
  assert.equal(profile.totalInteractions, 12);
});

test("批内顺序不影响最终档案", () => {
  const records: SourceRecord[] = [
    { sourceId: "a", recordId: "1", email: "x@x.com", tags: ["t1"], interactions: 1 },
    { sourceId: "b", recordId: "2", externalId: "E1", tags: ["t2"], interactions: 2 },
    { sourceId: "c", recordId: "3", email: "x@x.com", externalId: "E1", tags: ["t3"], interactions: 3 },
    { sourceId: "d", recordId: "4", tags: ["t4"], interactions: 4 },
  ];
  const forward = new IdentityStore();
  forward.submitBatch(records);
  const reversed = new IdentityStore();
  reversed.submitBatch([...records].reverse());

  for (const key of records) {
    const pf = forward.getProfileOf(key)!;
    const pr = reversed.getProfileOf(key)!;
    assert.deepEqual(
      [...pr.members].map((m) => `${m.sourceId}/${m.recordId}`).sort(),
      [...pf.members].map((m) => `${m.sourceId}/${m.recordId}`).sort(),
    );
    assert.deepEqual([...pr.tags].sort(), [...pf.tags].sort());
    assert.equal(pr.totalInteractions, pf.totalInteractions);
  }
});

test("相同标签由多个成员支持时，移除一个成员不删除该标签", () => {
  const store = new IdentityStore();
  store.submitBatch([
    { sourceId: "a", recordId: "1", email: "x@x.com", tags: ["shared"], interactions: 1 },
    { sourceId: "b", recordId: "2", email: "x@x.com", tags: ["shared"], interactions: 2 },
  ]);
  // b/2 撤回 email 独立出去，a/1 仍支持 shared 标签
  store.submitBatch([
    { sourceId: "b", recordId: "2", tags: ["shared"], interactions: 2 },
  ]);
  const pa = store.getProfileOf({ sourceId: "a", recordId: "1" })!;
  assert.deepEqual([...pa.tags], ["shared"]);
  assert.equal(pa.totalInteractions, 1);
  const pb = store.getProfileOf({ sourceId: "b", recordId: "2" })!;
  assert.deepEqual([...pb.tags], ["shared"]);
});

test("标识不变时标签与互动的更新即时生效", () => {
  const store = new IdentityStore();
  store.submitBatch([
    { sourceId: "a", recordId: "1", email: "x@x.com", tags: ["old"], interactions: 1 },
  ]);
  store.submitBatch([
    { sourceId: "a", recordId: "1", email: "x@x.com", tags: ["new"], interactions: 9 },
  ]);
  const profile = store.getProfileOf({ sourceId: "a", recordId: "1" })!;
  assert.deepEqual([...profile.tags], ["new"]);
  assert.equal(profile.totalInteractions, 9);
});

test("查询不存在的记录键返回 undefined", () => {
  const store = new IdentityStore();
  assert.equal(
    store.getProfileOf({ sourceId: "nope", recordId: "nope" }),
    undefined,
  );
});
