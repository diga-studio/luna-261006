"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const kernel_1 = require("../src/kernel");
function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}
/** 校验快照不变量：每台主机 归属占用 + 有效预占 <= 容量（两个维度）。 */
function assertInvariant(snap) {
    for (const host of snap.hosts) {
        strict_1.default.ok(host.used.cpu + host.reserved.cpu <= host.capacity.cpu, `host ${host.hostId} cpu over capacity`);
        strict_1.default.ok(host.used.memory + host.reserved.memory <= host.capacity.memory, `host ${host.hostId} memory over capacity`);
        if (host.state === kernel_1.HostState.Maintenance) {
            strict_1.default.equal(host.sessions.length, 0, `maintenance host ${host.hostId} holds sessions`);
            strict_1.default.deepEqual(host.reserved, { cpu: 0, memory: 0 }, `maintenance host ${host.hostId} holds reservations`);
        }
    }
    // 每个未关闭会话恰有一个归属主机。
    for (const session of snap.sessions) {
        const owners = snap.hosts.filter((h) => h.sessions.includes(session.sessionId));
        strict_1.default.equal(owners.length, 1, `session ${session.sessionId} must have exactly one owner`);
        strict_1.default.equal(owners[0].hostId, session.hostId);
    }
    // 预占必须指向未关闭会话，且源归属一致。
    for (const prep of snap.preparations) {
        const session = snap.sessions.find((s) => s.sessionId === prep.sessionId);
        strict_1.default.ok(session, `preparation ${prep.attemptId} references a live session`);
        strict_1.default.equal(session.hostId, prep.fromHost);
    }
}
function makeConfig(overrides) {
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
(0, node_test_1.test)("admit: 容量不足拒绝，非在线主机拒绝，重复 close 无副作用", async () => {
    const k = new kernel_1.MigrationKernel(makeConfig());
    const a = k.admit("p", "h1");
    const b = k.admit("p", "h1");
    strict_1.default.ok(a.ok && b.ok);
    const c = k.admit("p", "h1"); // h1 已满 (2/2)
    strict_1.default.equal(c.ok, false);
    strict_1.default.match(c.ok ? "" : c.reason, /insufficient capacity/);
    strict_1.default.equal(k.admit("nope", "h1").ok, false);
    strict_1.default.equal(k.admit("p", "nope").ok, false);
    k.close(a.ok ? a.sessionId : "");
    k.close(a.ok ? a.sessionId : ""); // 重复关闭无副作用
    k.close("ghost");
    const snap = k.snapshot();
    strict_1.default.equal(snap.sessions.length, 1);
    assertInvariant(snap);
    // 迁出中主机禁止新建。
    const d = k.admit("p", "h2");
    strict_1.default.ok(d.ok);
    const drainPromise = k.drain("h2"); // h2 有会话且无失败处理器 -> 默认准备成功迁出
    await drainPromise;
    strict_1.default.equal(k.admit("p", "h2").ok, false);
});
(0, node_test_1.test)("drain: 两个准备一成功一失败；重试时成功会话不回滚、失败会话可继续迁出", async () => {
    const behaviors = new Map();
    const k = new kernel_1.MigrationKernel(makeConfig({
        prepare: (att) => {
            const fn = behaviors.get(att.attemptId);
            return fn ? fn() : Promise.resolve();
        },
    }));
    const s1 = k.admit("p", "h1");
    const s2 = k.admit("p", "h1");
    strict_1.default.ok(s1.ok && s2.ok);
    // 第一轮：s1 准备成功，s2 准备失败。
    behaviors.set(`drain-h1-${s1.sessionId}`, () => Promise.resolve());
    behaviors.set(`drain-h1-${s2.sessionId}`, () => Promise.reject(new Error("target busy")));
    const first = await k.drain("h1");
    strict_1.default.deepEqual(first, { ok: false, reason: "blocked", remaining: 1 });
    let snap = k.snapshot();
    const s1View = snap.sessions.find((s) => s.sessionId === s1.sessionId);
    const s2View = snap.sessions.find((s) => s.sessionId === s2.sessionId);
    strict_1.default.notEqual(s1View.hostId, "h1", "成功准备的会话已迁出");
    strict_1.default.equal(s2View.hostId, "h1", "失败会话仍属源主机");
    strict_1.default.equal(snap.preparations.length, 0, "失败不得留下失效预占");
    strict_1.default.equal(snap.hosts.find((h) => h.hostId === "h1").state, kernel_1.HostState.Draining);
    assertInvariant(snap);
    // 重试：s2 这次成功；s1 不得回滚。
    behaviors.set(`drain-h1-${s2.sessionId}`, () => Promise.resolve());
    const second = await k.drain("h1");
    strict_1.default.deepEqual(second, { ok: true });
    snap = k.snapshot();
    strict_1.default.equal(snap.hosts.find((h) => h.hostId === "h1").state, kernel_1.HostState.Maintenance);
    strict_1.default.equal(snap.sessions.find((s) => s.sessionId === s1.sessionId).hostId, s1View.hostId, "已迁出会话不回滚");
    strict_1.default.notEqual(snap.sessions.find((s) => s.sessionId === s2.sessionId).hostId, "h1");
    assertInvariant(snap);
    // 已在维护中的主机直接返回成功。
    strict_1.default.deepEqual(await k.drain("h1"), { ok: true });
});
(0, node_test_1.test)("准备挂起时关闭源会话：成功回报不得提交，无复活、无残留预占", async () => {
    const gate = deferred();
    const k = new kernel_1.MigrationKernel(makeConfig({ prepare: () => gate.promise }));
    const s1 = k.admit("p", "h1");
    strict_1.default.ok(s1.ok);
    const pending = k.prepareMigration("a1", s1.sessionId, "h1", "h2");
    // 挂起期间可观察：源占用仍在，目标有预占，归属未变。
    let snap = k.snapshot();
    strict_1.default.equal(snap.sessions.find((s) => s.sessionId === s1.sessionId).hostId, "h1");
    strict_1.default.deepEqual(snap.hosts.find((h) => h.hostId === "h1").used, { cpu: 1, memory: 1 });
    strict_1.default.deepEqual(snap.hosts.find((h) => h.hostId === "h2").reserved, { cpu: 1, memory: 1 });
    strict_1.default.deepEqual(snap.preparations, [
        { attemptId: "a1", sessionId: s1.sessionId, fromHost: "h1", toHost: "h2" },
    ]);
    assertInvariant(snap);
    // 关闭源会话：立即作废准备并释放目标预占与源占用。
    k.close(s1.sessionId);
    snap = k.snapshot();
    strict_1.default.equal(snap.sessions.length, 0);
    strict_1.default.equal(snap.preparations.length, 0);
    strict_1.default.deepEqual(snap.hosts.find((h) => h.hostId === "h2").reserved, { cpu: 0, memory: 0 });
    strict_1.default.deepEqual(snap.hosts.find((h) => h.hostId === "h1").used, { cpu: 0, memory: 0 });
    // 迟到成功回报：不得提交、不得复活会话。
    gate.resolve();
    const result = await pending;
    strict_1.default.equal(result.ok, false);
    snap = k.snapshot();
    strict_1.default.equal(snap.sessions.length, 0, "会话不得复活");
    strict_1.default.equal(snap.preparations.length, 0, "不得残留预占");
    assertInvariant(snap);
});
(0, node_test_1.test)("准备挂起时目标进入维护：成功回报不得提交，源归属不变", async () => {
    const gate = deferred();
    const k = new kernel_1.MigrationKernel(makeConfig({ prepare: () => gate.promise }));
    const s1 = k.admit("p", "h1");
    strict_1.default.ok(s1.ok);
    const pending = k.prepareMigration("a1", s1.sessionId, "h1", "h2");
    strict_1.default.equal(k.snapshot().preparations.length, 1);
    // 目标开始维护：立即作废未提交准备并释放预占；h2 无会话，直接进维护中。
    const drained = await k.drain("h2");
    strict_1.default.deepEqual(drained, { ok: true });
    let snap = k.snapshot();
    strict_1.default.equal(snap.hosts.find((h) => h.hostId === "h2").state, kernel_1.HostState.Maintenance);
    strict_1.default.equal(snap.preparations.length, 0, "目标预占已释放");
    strict_1.default.equal(snap.sessions.find((s) => s.sessionId === s1.sessionId).hostId, "h1", "目标维护不改变源归属");
    // 迟到成功回报：不得提交、不得非法迁入维护中主机。
    gate.resolve();
    const result = await pending;
    strict_1.default.equal(result.ok, false);
    snap = k.snapshot();
    strict_1.default.equal(snap.sessions.find((s) => s.sessionId === s1.sessionId).hostId, "h1");
    const h2 = snap.hosts.find((h) => h.hostId === "h2");
    strict_1.default.equal(h2.state, kernel_1.HostState.Maintenance);
    strict_1.default.equal(h2.sessions.length, 0);
    strict_1.default.deepEqual(h2.reserved, { cpu: 0, memory: 0 });
    assertInvariant(snap);
    // 维护中主机拒绝新的迁入准备。
    const rejected = await k.prepareMigration("a2", s1.sessionId, "h1", "h2");
    strict_1.default.equal(rejected.ok, false);
});
(0, node_test_1.test)("drain: 无可用目标时受阻且不留失效预占", async () => {
    const k = new kernel_1.MigrationKernel(makeConfig({ hosts: [{ hostId: "h1", capacity: { cpu: 1, memory: 1 } }] }));
    const s1 = k.admit("p", "h1");
    strict_1.default.ok(s1.ok);
    const result = await k.drain("h1");
    strict_1.default.deepEqual(result, { ok: false, reason: "blocked", remaining: 1 });
    const snap = k.snapshot();
    strict_1.default.equal(snap.hosts[0].state, kernel_1.HostState.Draining);
    strict_1.default.equal(snap.preparations.length, 0);
    assertInvariant(snap);
});
(0, node_test_1.test)("prepareMigration: 参数校验失败即返回失败，不产生预占", async () => {
    const k = new kernel_1.MigrationKernel(makeConfig());
    const s1 = k.admit("p", "h1");
    strict_1.default.ok(s1.ok);
    strict_1.default.equal((await k.prepareMigration("a1", "ghost", "h1", "h2")).ok, false);
    strict_1.default.equal((await k.prepareMigration("a2", s1.sessionId, "h2", "h3")).ok, false); // 源不符
    strict_1.default.equal((await k.prepareMigration("a3", s1.sessionId, "h1", "h1")).ok, false); // 同机
    strict_1.default.equal((await k.prepareMigration("a4", s1.sessionId, "h1", "ghost")).ok, false);
    // 目标容量不足：h2 预占满后拒绝。
    const gate = deferred();
    const k2 = new kernel_1.MigrationKernel(makeConfig({ prepare: () => gate.promise }));
    const x1 = k2.admit("p", "h1");
    const x2 = k2.admit("p", "h1");
    strict_1.default.ok(x1.ok && x2.ok);
    const p1 = k2.prepareMigration("b1", x1.sessionId, "h1", "h2");
    const p2 = k2.prepareMigration("b2", x2.sessionId, "h1", "h2");
    strict_1.default.equal((await k2.prepareMigration("b3", x1.sessionId, "h1", "h2")).ok, false, "同会话重复准备被拒");
    gate.resolve();
    strict_1.default.deepEqual(await p1, { ok: true });
    strict_1.default.equal((await p2).ok, true);
    const snap = k2.snapshot();
    strict_1.default.equal(snap.hosts.find((h) => h.hostId === "h2").sessions.length, 2);
    assertInvariant(snap);
});
