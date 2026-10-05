import { test } from "node:test";
import assert from "node:assert/strict";
import { IdentityStore } from "../../src/index.js";

test("匿名记录补齐标识后携带标签与互动进入新档案", () => {
  const store = new IdentityStore();
  store.submitBatch([
    { sourceId: "web", recordId: "anon-1", tags: ["浏览过A"], interactions: 3 },
    { sourceId: "crm", recordId: "c1", email: "u@x.com", tags: ["vip"], interactions: 10 },
  ]);
  assert.equal(store.profileCount, 2);

  // 匿名访客补充身份
  store.submitBatch([
    { sourceId: "web", recordId: "anon-1", email: "u@x.com", tags: ["浏览过A"], interactions: 3 },
  ]);

  assert.equal(store.profileCount, 1);
  const profile = store.getProfileOf({ sourceId: "web", recordId: "anon-1" })!;
  assert.equal(profile.members.size, 2);
  assert.deepEqual([...profile.tags].sort(), ["vip", "浏览过A"]);
  assert.equal(profile.totalInteractions, 13);
});

test("匿名识别后再纠错拆分，标签与互动跟随原记录不残留", () => {
  const store = new IdentityStore();
  store.submitBatch([
    { sourceId: "web", recordId: "anon-1", tags: ["匿名标签"], interactions: 4 },
    { sourceId: "crm", recordId: "c1", email: "u@x.com", tags: ["crm标签"], interactions: 6 },
    { sourceId: "crm", recordId: "c2", email: "u@x.com", tags: ["crm标签"], interactions: 1 },
  ]);
  // 误识别：匿名记录其实属于另一个人
  store.submitBatch([
    { sourceId: "web", recordId: "anon-1", email: "u@x.com", tags: ["匿名标签"], interactions: 4 },
  ]);
  assert.equal(store.profileCount, 1);

  // 纠错：撤回该 email，匿名记录恢复独立
  store.submitBatch([
    { sourceId: "web", recordId: "anon-1", tags: ["匿名标签"], interactions: 4 },
  ]);

  assert.equal(store.profileCount, 2);
  const anon = store.getProfileOf({ sourceId: "web", recordId: "anon-1" })!;
  assert.deepEqual([...anon.members].map((m) => m.recordId), ["anon-1"]);
  assert.deepEqual([...anon.tags], ["匿名标签"]);
  assert.equal(anon.totalInteractions, 4);

  const crm = store.getProfileOf({ sourceId: "crm", recordId: "c1" })!;
  assert.equal(crm.members.size, 2);
  assert.deepEqual([...crm.tags], ["crm标签"]);
  assert.equal(crm.totalInteractions, 7);
});

test("匿名记录纠错后改挂到正确客户", () => {
  const store = new IdentityStore();
  store.submitBatch([
    { sourceId: "web", recordId: "anon-1", email: "wrong@x.com", tags: ["T"], interactions: 2 },
    { sourceId: "crm", recordId: "c1", email: "wrong@x.com", tags: ["W"], interactions: 1 },
    { sourceId: "crm", recordId: "c2", email: "right@x.com", tags: ["R"], interactions: 8 },
  ]);
  assert.equal(store.profileCount, 2);

  store.submitBatch([
    { sourceId: "web", recordId: "anon-1", email: "right@x.com", tags: ["T"], interactions: 2 },
  ]);

  const wrong = store.getProfileOf({ sourceId: "crm", recordId: "c1" })!;
  assert.deepEqual([...wrong.tags], ["W"]);
  assert.equal(wrong.totalInteractions, 1);
  const right = store.getProfileOf({ sourceId: "crm", recordId: "c2" })!;
  assert.equal(right.members.size, 2);
  assert.deepEqual([...right.tags].sort(), ["R", "T"]);
  assert.equal(right.totalInteractions, 10);
});
