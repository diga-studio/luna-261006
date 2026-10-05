import test from "node:test";
import assert from "node:assert/strict";
import { MAX_BATCH_SIZE, ProfileStore } from "../src/index.ts";
import { keyOf, profileShape, rec } from "./helpers.ts";

test("email 相同即匹配，跨 source_id 生效，另一标识不同不阻断", () => {
  const store = new ProfileStore();
  store.submitBatch([
    rec("web", "1", { email: "a@x.com", externalId: "ext-1", tags: ["t1"], interactions: 2 }),
    rec("app", "2", { email: "a@x.com", externalId: "ext-2", tags: ["t2"], interactions: 3 }),
  ]);
  const profile = store.getProfileByRecord("web", "1");
  assert.ok(profile);
  assert.deepEqual(profileShape(profile), {
    members: [keyOf("app", "2"), keyOf("web", "1")],
    tags: ["t1", "t2"],
    interactions: 5,
  });
});

test("external_id 相同即匹配，且具有传递性", () => {
  const store = new ProfileStore();
  store.submitBatch([
    rec("s1", "1", { email: "a@x.com" }),
    rec("s2", "2", { email: "a@x.com", externalId: "e-9" }),
    rec("s3", "3", { externalId: "e-9" }),
  ]);
  const profile = store.getProfileByRecord("s3", "3");
  assert.ok(profile);
  assert.deepEqual(
    profileShape(profile).members,
    [keyOf("s1", "1"), keyOf("s2", "2"), keyOf("s3", "3")],
  );
});

test("email 与 external_id 是不同标识域，字符串相同不构成匹配", () => {
  const store = new ProfileStore();
  store.submitBatch([
    rec("s1", "1", { email: "same-string" }),
    rec("s2", "2", { externalId: "same-string" }),
  ]);
  const p1 = store.getProfileByRecord("s1", "1");
  const p2 = store.getProfileByRecord("s2", "2");
  assert.ok(p1 && p2);
  assert.notEqual(p1.profileId, p2.profileId);
  assert.equal(store.profileCount, 2);
});

test("两个标识都缺省的记录各自独立", () => {
  const store = new ProfileStore();
  store.submitBatch([rec("s1", "1"), rec("s1", "2"), rec("s2", "3")]);
  assert.equal(store.profileCount, 3);
});

test("撤回桥接标识后，没有其他路径维系的旧档案必须拆开", () => {
  const store = new ProfileStore();
  // bridge 同时持有两个 email，把 a 侧与 b 侧连成同一客户。
  store.submitBatch([
    rec("s1", "a", { email: "a@x.com", tags: ["ta"], interactions: 1 }),
    rec("s1", "bridge", { email: "a@x.com", externalId: "x-1", tags: ["tb"], interactions: 2 }),
    rec("s2", "b", { externalId: "x-1", tags: ["tc"], interactions: 4 }),
  ]);
  assert.equal(store.profileCount, 1);

  // 来源纠错：bridge 的 external_id 是误填，撤回。
  store.submitBatch([rec("s1", "bridge", { email: "a@x.com", tags: ["tb"], interactions: 2 })]);
  assert.equal(store.profileCount, 2);

  const sideA = store.getProfileByRecord("s1", "a");
  const sideB = store.getProfileByRecord("s2", "b");
  assert.ok(sideA && sideB);
  assert.notEqual(sideA.profileId, sideB.profileId);
  assert.deepEqual(profileShape(sideA), {
    members: [keyOf("s1", "a"), keyOf("s1", "bridge")],
    tags: ["ta", "tb"],
    interactions: 3,
  });
  assert.deepEqual(profileShape(sideB), {
    members: [keyOf("s2", "b")],
    tags: ["tc"],
    interactions: 4,
  });
});

test("撤回标识后仍存在其他匹配路径的档案不能误拆", () => {
  const store = new ProfileStore();
  // a 与 b 之间有两条路径：email 直连 + 经 bridge 的 external_id。
  store.submitBatch([
    rec("s1", "a", { email: "shared@x.com", tags: ["ta"], interactions: 1 }),
    rec("s1", "bridge", { email: "shared@x.com", externalId: "x-1", tags: ["tb"], interactions: 2 }),
    rec("s2", "b", { email: "shared@x.com", externalId: "x-1", tags: ["tc"], interactions: 4 }),
  ]);
  assert.equal(store.profileCount, 1);

  // bridge 撤回 external_id，但 email 路径仍然维系三者。
  store.submitBatch([rec("s1", "bridge", { email: "shared@x.com", tags: ["tb"], interactions: 2 })]);
  assert.equal(store.profileCount, 1);
  const profile = store.getProfileByRecord("s2", "b");
  assert.ok(profile);
  assert.deepEqual(profileShape(profile), {
    members: [keyOf("s1", "a"), keyOf("s1", "bridge"), keyOf("s2", "b")],
    tags: ["ta", "tb", "tc"],
    interactions: 7,
  });
});

test("匿名记录补齐标识后进入新档案，再次纠错后数据跟随原记录", () => {
  const store = new ProfileStore();
  store.submitBatch([
    rec("web", "anon-1", { tags: ["浏览过A"], interactions: 5 }),
    rec("crm", "c-1", { email: "u@x.com", tags: ["会员"], interactions: 10 }),
  ]);
  assert.equal(store.profileCount, 2);

  // 匿名访客补充身份：并入 crm 档案，标签与互动随之进入。
  store.submitBatch([
    rec("web", "anon-1", { email: "u@x.com", tags: ["浏览过A"], interactions: 5 }),
  ]);
  assert.equal(store.profileCount, 1);
  let profile = store.getProfileByRecord("crm", "c-1");
  assert.ok(profile);
  assert.deepEqual(profileShape(profile), {
    members: [keyOf("crm", "c-1"), keyOf("web", "anon-1")],
    tags: ["会员", "浏览过A"],
    interactions: 15,
  });

  // 来源纠错：该 email 是误填，撤回。互动与标签跟随 anon-1 离开，不残留。
  store.submitBatch([rec("web", "anon-1", { tags: ["浏览过A"], interactions: 5 })]);
  assert.equal(store.profileCount, 2);
  profile = store.getProfileByRecord("crm", "c-1");
  assert.ok(profile);
  assert.deepEqual(profileShape(profile), {
    members: [keyOf("crm", "c-1")],
    tags: ["会员"],
    interactions: 10,
  });
  const anon = store.getProfileByRecord("web", "anon-1");
  assert.ok(anon);
  assert.deepEqual(profileShape(anon), {
    members: [keyOf("web", "anon-1")],
    tags: ["浏览过A"],
    interactions: 5,
  });
});

test("相同标签由多个成员支持时，失去一个成员不移除该标签", () => {
  const store = new ProfileStore();
  store.submitBatch([
    rec("s1", "1", { email: "a@x.com", tags: ["vip"], interactions: 1 }),
    rec("s2", "2", { email: "a@x.com", tags: ["vip"], interactions: 2 }),
  ]);
  assert.deepEqual(store.getProfileByRecord("s1", "1")?.tags, ["vip"]);

  // 纠错：s2/2 的 email 是误填，改成别的。vip 仍被 s1/1 支持，必须保留。
  store.submitBatch([rec("s2", "2", { email: "b@x.com", tags: ["vip"], interactions: 2 })]);
  const p1 = store.getProfileByRecord("s1", "1");
  assert.ok(p1);
  assert.deepEqual(profileShape(p1), {
    members: [keyOf("s1", "1")],
    tags: ["vip"],
    interactions: 1,
  });
});

test("已有记录被完整替换，标签与互动是现值而非增量", () => {
  const store = new ProfileStore();
  store.submitBatch([rec("s1", "1", { email: "a@x.com", tags: ["old"], interactions: 7 })]);
  store.submitBatch([rec("s1", "1", { email: "a@x.com", tags: ["new"], interactions: 3 })]);
  const profile = store.getProfileByRecord("s1", "1");
  assert.ok(profile);
  assert.deepEqual(profileShape(profile), {
    members: [keyOf("s1", "1")],
    tags: ["new"],
    interactions: 3,
  });
});

test("重复提交相同快照是幂等的，互动次数不增加", () => {
  const store = new ProfileStore();
  const batch = [
    rec("s1", "1", { email: "a@x.com", tags: ["t"], interactions: 5 }),
    rec("s2", "2", { email: "a@x.com", tags: ["t"], interactions: 5 }),
  ];
  store.submitBatch(batch);
  store.submitBatch(batch);
  store.submitBatch(batch);
  const profile = store.getProfileByRecord("s1", "1");
  assert.ok(profile);
  assert.equal(profile.interactions, 10);
  assert.equal(store.profileCount, 1);
});

test("批内顺序不影响最终档案", () => {
  const batch = [
    rec("s1", "1", { email: "a@x.com", tags: ["t1"], interactions: 1 }),
    rec("s2", "2", { externalId: "e-1", tags: ["t2"], interactions: 2 }),
    rec("s3", "3", { email: "a@x.com", externalId: "e-1", tags: ["t3"], interactions: 3 }),
    rec("s4", "4", { tags: ["t4"], interactions: 4 }),
  ];
  const forward = new ProfileStore();
  const reversed = new ProfileStore();
  forward.submitBatch(batch);
  reversed.submitBatch([...batch].reverse());
  assert.equal(forward.profileCount, reversed.profileCount);
  for (const source of batch) {
    const a = forward.getProfileByRecord(source.sourceId, source.recordId);
    const b = reversed.getProfileByRecord(source.sourceId, source.recordId);
    assert.ok(a && b);
    assert.deepEqual(profileShape(a), profileShape(b));
  }
});

test("旧标识纠错后不再参与匹配", () => {
  const store = new ProfileStore();
  store.submitBatch([rec("s1", "1", { email: "typo@x.com", tags: ["t"], interactions: 1 })]);
  store.submitBatch([rec("s1", "1", { email: "fixed@x.com", tags: ["t"], interactions: 1 })]);
  // 新记录使用旧标识，不应再关联到 s1/1。
  store.submitBatch([rec("s2", "2", { email: "typo@x.com", tags: ["u"], interactions: 2 })]);
  const p1 = store.getProfileByRecord("s1", "1");
  const p2 = store.getProfileByRecord("s2", "2");
  assert.ok(p1 && p2);
  assert.notEqual(p1.profileId, p2.profileId);
  assert.deepEqual(profileShape(p2).members, [keyOf("s2", "2")]);
});

test("单批超过 5000 条或同批键重复时拒绝提交", () => {
  const store = new ProfileStore();
  const oversized = Array.from({ length: MAX_BATCH_SIZE + 1 }, (_, i) => rec("s", `r${i}`));
  assert.throws(() => store.submitBatch(oversized), RangeError);
  assert.throws(
    () => store.submitBatch([rec("s", "1"), rec("s", "1")]),
    /duplicate record key/,
  );
  // 校验失败不得改变已有状态。
  assert.equal(store.recordCount, 0);
  assert.equal(store.profileCount, 0);
});

test("查询不存在的记录返回 undefined", () => {
  const store = new ProfileStore();
  assert.equal(store.getProfileByRecord("nope", "nope"), undefined);
});
