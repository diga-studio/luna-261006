import { test } from "node:test";
import assert from "node:assert/strict";
import { MigrationKernel, HostState } from "../src/kernel";
import { KernelConfig, KernelSnapshot } from "../src/types";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 校验快照不变量：每台主机 归属占用 + 有效预占 <= 容量（两个维度）。 */
function assertInvariant(snap: KernelSnapshot) {
  for (const host of snap.hosts) {
    assert.ok(
      host.used.cpu + host.reserved.cpu <= host.capacity.cpu,
      `host ${host.hostId} cpu over capacity`
    );
    assert.ok(
      host.used.memory + host.reserved.memory <= host.capacity.memory,
      `host ${host.hostId} memory over capacity`
    );
    if (host.state === HostState.Maintenance) {
      assert.equal(host.sessions.length, 0, `maintenance host ${host.hostId} holds sessions`);
      assert.deepEqual(host.reserved, { cpu: 0, memory: 0 }, `maintenance host ${host.hostId} holds reservations`);
    }
  }
  // 每个未关闭会话恰有一个归属主机。
  for (const session of snap.sessions) {
    const owners = snap.hosts.filter((h) => h.sessions.includes(session.sessionId));
    assert.equal(owners.length, 1, `session ${session.sessionId} must have exactly one owner`);
    assert.equal(owners[0]!.hostId, session.hostId);
  }
  // 预占必须指向未关闭会话，且源归属一致。
  for (const prep of snap.preparations) {
    const session = snap.sessions.find((s) => s.sessionId === prep.sessionId);
    assert.ok(session, `preparation ${prep.attemptId} references a live session`);
    assert.equal(session!.hostId, prep.fromHost);
  }
}

function makeConfig(overrides?: Partial<KernelConfig>): KernelConfig {
  return {
    hosts: [
      { hostId: "h1", capacity: { cpu: 2, memory: 2 } },
      { hostId: "h2", capacity: { cpu: 2, memory: 2 } },
      { hostId: "h3", capacity: { cpu: 2, memory: 2 } },
    ],
    pools: [{ poolId: "p", perSession: { cpu: 1, memory: 1 } }],
    ...overrides,
  };
}

test("admit: 容量不足拒绝，非在线主机拒绝，重复 close 无副作用", async () => {
  const k = new MigrationKernel(makeConfig());
  const a = k.admit("p", "h1");
  const b = k.admit("p", "h1");
  assert.ok(a.ok && b.ok);
  const c = k.admit("p", "h1"); // h1 已满 (2/2)
  assert.equal(c.ok, false);
  assert.match(c.ok ? "" : c.reason, /insufficient capacity/);
  assert.equal(k.admit("nope", "h1").ok, false);
  assert.equal(k.admit("p", "nope").ok, false);

  k.close(a.ok ? a.sessionId : "");
  k.close(a.ok ? a.sessionId : ""); // 重复关闭无副作用
  k.close("ghost");
  const snap = k.snapshot();
  assert.equal(snap.sessions.length, 1);
  assertInvariant(snap);

  // 迁出中主机禁止新建。
  const d = k.admit("p", "h2");
  assert.ok(d.ok);
  const drainPromise = k.drain("h2"); // h2 有会话且无失败处理器 -> 默认准备成功迁出
  await drainPromise;
  assert.equal(k.admit("p", "h2").ok, false);
});

test("drain: 两个准备一成功一失败；重试时成功会话不回滚、失败会话可继续迁出", async () => {
  const behaviors = new Map<string, () => Promise<void>>();
  const k = new MigrationKernel(
    makeConfig({
      prepare: (att) => {
        const fn = behaviors.get(att.attemptId);
        return fn ? fn() : Promise.resolve();
      },
    })
  );
  const s1 = k.admit("p", "h1");
  const s2 = k.admit("p", "h1");
  assert.ok(s1.ok && s2.ok);

  // 第一轮：s1 准备成功，s2 准备失败。
  behaviors.set(`drain-h1-${s1.sessionId}`, () => Promise.resolve());
  behaviors.set(`drain-h1-${s2.sessionId}`, () => Promise.reject(new Error("target busy")));
  const first = await k.drain("h1");
  assert.deepEqual(first, { ok: false, reason: "blocked", remaining: 1 });

  let snap = k.snapshot();
  const s1View = snap.sessions.find((s) => s.sessionId === s1.sessionId)!;
  const s2View = snap.sessions.find((s) => s.sessionId === s2.sessionId)!;
  assert.notEqual(s1View.hostId, "h1", "成功准备的会话已迁出");
  assert.equal(s2View.hostId, "h1", "失败会话仍属源主机");
  assert.equal(snap.preparations.length, 0, "失败不得留下失效预占");
  assert.equal(snap.hosts.find((h) => h.hostId === "h1")!.state, HostState.Draining);
  assertInvariant(snap);

  // 重试：s2 这次成功；s1 不得回滚。
  behaviors.set(`drain-h1-${s2.sessionId}`, () => Promise.resolve());
  const second = await k.drain("h1");
  assert.deepEqual(second, { ok: true });
  snap = k.snapshot();
  assert.equal(snap.hosts.find((h) => h.hostId === "h1")!.state, HostState.Maintenance);
  assert.equal(
    snap.sessions.find((s) => s.sessionId === s1.sessionId)!.hostId,
    s1View.hostId,
    "已迁出会话不回滚"
  );
  assert.notEqual(snap.sessions.find((s) => s.sessionId === s2.sessionId)!.hostId, "h1");
  assertInvariant(snap);

  // 已在维护中的主机直接返回成功。
  assert.deepEqual(await k.drain("h1"), { ok: true });
});

test("准备挂起时关闭源会话：成功回报不得提交，无复活、无残留预占", async () => {
  const gate = deferred();
  const k = new MigrationKernel(makeConfig({ prepare: () => gate.promise }));
  const s1 = k.admit("p", "h1");
  assert.ok(s1.ok);

  const pending = k.prepareMigration("a1", s1.sessionId, "h1", "h2");
  // 挂起期间可观察：源占用仍在，目标有预占，归属未变。
  let snap = k.snapshot();
  assert.equal(snap.sessions.find((s) => s.sessionId === s1.sessionId)!.hostId, "h1");
  assert.deepEqual(snap.hosts.find((h) => h.hostId === "h1")!.used, { cpu: 1, memory: 1 });
  assert.deepEqual(snap.hosts.find((h) => h.hostId === "h2")!.reserved, { cpu: 1, memory: 1 });
  assert.deepEqual(snap.preparations, [
    { attemptId: "a1", sessionId: s1.sessionId, fromHost: "h1", toHost: "h2" },
  ]);
  assertInvariant(snap);

  // 关闭源会话：立即作废准备并释放目标预占与源占用。
  k.close(s1.sessionId);
  snap = k.snapshot();
  assert.equal(snap.sessions.length, 0);
  assert.equal(snap.preparations.length, 0);
  assert.deepEqual(snap.hosts.find((h) => h.hostId === "h2")!.reserved, { cpu: 0, memory: 0 });
  assert.deepEqual(snap.hosts.find((h) => h.hostId === "h1")!.used, { cpu: 0, memory: 0 });

  // 迟到成功回报：不得提交、不得复活会话。
  gate.resolve();
  const result = await pending;
  assert.equal(result.ok, false);
  snap = k.snapshot();
  assert.equal(snap.sessions.length, 0, "会话不得复活");
  assert.equal(snap.preparations.length, 0, "不得残留预占");
  assertInvariant(snap);
});

test("准备挂起时目标进入维护：成功回报不得提交，源归属不变", async () => {
  const gate = deferred();
  const k = new MigrationKernel(makeConfig({ prepare: () => gate.promise }));
  const s1 = k.admit("p", "h1");
  assert.ok(s1.ok);

  const pending = k.prepareMigration("a1", s1.sessionId, "h1", "h2");
  assert.equal(k.snapshot().preparations.length, 1);

  // 目标开始维护：立即作废未提交准备并释放预占；h2 无会话，直接进维护中。
  const drained = await k.drain("h2");
  assert.deepEqual(drained, { ok: true });
  let snap = k.snapshot();
  assert.equal(snap.hosts.find((h) => h.hostId === "h2")!.state, HostState.Maintenance);
  assert.equal(snap.preparations.length, 0, "目标预占已释放");
  assert.equal(
    snap.sessions.find((s) => s.sessionId === s1.sessionId)!.hostId,
    "h1",
    "目标维护不改变源归属"
  );

  // 迟到成功回报：不得提交、不得非法迁入维护中主机。
  gate.resolve();
  const result = await pending;
  assert.equal(result.ok, false);
  snap = k.snapshot();
  assert.equal(snap.sessions.find((s) => s.sessionId === s1.sessionId)!.hostId, "h1");
  const h2 = snap.hosts.find((h) => h.hostId === "h2")!;
  assert.equal(h2.state, HostState.Maintenance);
  assert.equal(h2.sessions.length, 0);
  assert.deepEqual(h2.reserved, { cpu: 0, memory: 0 });
  assertInvariant(snap);

  // 维护中主机拒绝新的迁入准备。
  const rejected = await k.prepareMigration("a2", s1.sessionId, "h1", "h2");
  assert.equal(rejected.ok, false);
});

test("drain: 无可用目标时受阻且不留失效预占", async () => {
  const k = new MigrationKernel(
    makeConfig({ hosts: [{ hostId: "h1", capacity: { cpu: 1, memory: 1 } }] })
  );
  const s1 = k.admit("p", "h1");
  assert.ok(s1.ok);
  const result = await k.drain("h1");
  assert.deepEqual(result, { ok: false, reason: "blocked", remaining: 1 });
  const snap = k.snapshot();
  assert.equal(snap.hosts[0]!.state, HostState.Draining);
  assert.equal(snap.preparations.length, 0);
  assertInvariant(snap);
});

test("prepareMigration: 参数校验失败即返回失败，不产生预占", async () => {
  const k = new MigrationKernel(makeConfig());
  const s1 = k.admit("p", "h1");
  assert.ok(s1.ok);
  assert.equal((await k.prepareMigration("a1", "ghost", "h1", "h2")).ok, false);
  assert.equal((await k.prepareMigration("a2", s1.sessionId, "h2", "h3")).ok, false); // 源不符
  assert.equal((await k.prepareMigration("a3", s1.sessionId, "h1", "h1")).ok, false); // 同机
  assert.equal((await k.prepareMigration("a4", s1.sessionId, "h1", "ghost")).ok, false);
  // 目标容量不足：h2 预占满后拒绝。
  const gate = deferred();
  const k2 = new MigrationKernel(makeConfig({ prepare: () => gate.promise }));
  const x1 = k2.admit("p", "h1");
  const x2 = k2.admit("p", "h1");
  assert.ok(x1.ok && x2.ok);
  const p1 = k2.prepareMigration("b1", x1.sessionId, "h1", "h2");
  const p2 = k2.prepareMigration("b2", x2.sessionId, "h1", "h2");
  assert.equal((await k2.prepareMigration("b3", x1.sessionId, "h1", "h2")).ok, false, "同会话重复准备被拒");
  gate.resolve();
  assert.deepEqual(await p1, { ok: true });
  assert.equal((await p2).ok, true);
  const snap = k2.snapshot();
  assert.equal(snap.hosts.find((h) => h.hostId === "h2")!.sessions.length, 2);
  assertInvariant(snap);
});
