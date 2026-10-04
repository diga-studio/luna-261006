import { test } from "node:test";
import assert from "node:assert/strict";
import { RingGateway } from "../src/index.js";
import type { Action, ActionSink, CallResult } from "../src/index.js";

/** 记录动作并按 分机/来电 索引支路，便于测试回报事件 */
class Harness {
  readonly actions: Action[] = [];
  readonly gw: RingGateway;

  constructor(sink?: ActionSink, ringTimeoutMs?: number) {
    this.gw = new RingGateway(sink ?? ((a) => this.actions.push(a)), {
      ringTimeoutMs,
    });
  }

  ringsFor(callId: string): Action[] {
    return this.actions.filter((a) => a.type === "ring" && a.callId === callId);
  }

  branchOf(callId: string, extensionId: string): string {
    const hit = this.actions.find(
      (a) => a.type === "ring" && a.callId === callId && a.extensionId === extensionId,
    );
    assert.ok(hit, `no ring delivered for ${callId}/${extensionId}`);
    return hit.branchId;
  }

  count(type: Action["type"], branchId: string): number {
    return this.actions.filter((a) => a.type === type && a.branchId === branchId).length;
  }

  result(callId: string): CallResult {
    const r = this.gw.getCallResult(callId);
    assert.ok(r, `missing call result for ${callId}`);
    return r;
  }

  used(extensionId: string): number {
    const u = this.gw.getExtensionUsage(extensionId);
    assert.ok(u, `missing extension ${extensionId}`);
    return u.used;
  }
}

function buildOverlapping(h: Harness = new Harness()): Harness {
  // e1 同时属于销售组和售后组
  h.gw.addExtension("e1", 1);
  h.gw.addExtension("e2", 1);
  h.gw.addExtension("e3", 1);
  h.gw.addRingGroup("sales", ["e1", "e2"]);
  h.gw.addRingGroup("support", ["e1", "e3"]);
  return h;
}

test("重叠组争抢到容量上限：撤销未终止时名额不可用，终止后可复用，重复回报不挤出名额", () => {
  const h = buildOverlapping(new Harness());

  // 第一通销售来电：e1、e2 各预约一个名额
  const r1 = h.gw.incomingCall("c1", "sales");
  assert.equal(r1.status, "ringing");
  assert.equal(h.used("e1"), 1);
  assert.equal(h.used("e2"), 1);

  // e1 接听成为赢家，e2 被撤销（canceling，名额仍占用）
  h.gw.report(h.branchOf("c1", "e1"), "answer");
  assert.equal(h.result("c1").status, "answered");
  assert.equal(h.result("c1").winner, "e1");
  const b2 = h.branchOf("c1", "e2");
  assert.equal(h.count("cancel", b2), 1);
  assert.equal(h.used("e2"), 1, "撤销未终止，名额仍占用");

  // 售后来电：e1 满，e3 有余量 -> 只给 e3 振铃
  h.gw.incomingCall("c2", "support");
  assert.deepEqual(h.ringsFor("c2").map((a) => a.extensionId), ["e3"]);

  // e2 的撤销尚未终止：新销售来电只能使用 e2 以外的名额 -> e1 满、e2 占用 -> 忙线
  const r3 = h.gw.incomingCall("c3", "sales");
  assert.equal(r3.status, "busy");

  // e2 撤销终止（拒接回报），名额释放
  h.gw.report(b2, "reject");
  assert.equal(h.used("e2"), 0);

  // 重复投递旧终止回报不得再次释放名额
  h.gw.report(b2, "reject");
  h.gw.report(b2, "lineEnd");
  assert.equal(h.used("e2"), 0);

  // 终止后名额可复用
  const r4 = h.gw.incomingCall("c4", "sales");
  assert.equal(r4.status, "ringing");
  assert.deepEqual(h.ringsFor("c4").map((a) => a.extensionId), ["e2"]);
  assert.equal(h.used("e2"), 1);
});

test("两条支路交错接听：先处理者为唯一赢家，迟到接听收到挂断", () => {
  const h = buildOverlapping(new Harness());
  h.gw.incomingCall("c1", "sales");
  const b1 = h.branchOf("c1", "e1");
  const b2 = h.branchOf("c1", "e2");

  h.gw.report(b1, "answer");
  h.gw.report(b2, "answer"); // 撤销途中接听 -> 挂断

  assert.equal(h.result("c1").winner, "e1");
  assert.equal(h.count("hangup", b2), 1, "迟到接听另发挂断");
  assert.equal(h.count("hangup", b1), 0);

  // 迟到的挂断完成回报
  h.gw.report(b2, "lineEnd");
  assert.equal(h.used("e2"), 0);

  // 赢家线路结束 -> 整通来电结束
  h.gw.report(b1, "lineEnd");
  const r = h.result("c1");
  assert.equal(r.status, "ended");
  assert.equal(r.winner, "e1");
  assert.equal(r.finalized, true);
  assert.equal(h.used("e1"), 0);
});

test("接听恰逢超时边界：超时处理后到达的接听不能复活来电", () => {
  const h = buildOverlapping(new Harness());
  h.gw.incomingCall("c1", "sales"); // t=0 发起，deadline=10000
  const b1 = h.branchOf("c1", "e1");
  const b2 = h.branchOf("c1", "e2");

  // 业务时间推进到恰好截止时刻 -> 算超时
  h.gw.advanceTime(10_000);
  assert.equal(h.count("cancel", b1), 1);
  assert.equal(h.count("cancel", b2), 1);

  // 超时后到达的接听 -> 挂断，不产生赢家
  h.gw.report(b1, "answer");
  assert.equal(h.count("hangup", b1), 1);
  assert.equal(h.result("c1").winner, null);

  // 支路终止后来电以未接听结束，不复活
  h.gw.report(b1, "lineEnd");
  h.gw.report(b2, "reject");
  const r = h.result("c1");
  assert.equal(r.status, "no-answer");
  assert.equal(r.finalized, true);
  assert.equal(h.used("e1"), 0);
  assert.equal(h.used("e2"), 0);

  // 终止后的迟到事件一律忽略
  h.gw.report(b1, "answer");
  assert.equal(h.count("hangup", b1), 1, "挂断至多一次");
});

test("截止前一刻的接听有效，且不再超时", () => {
  const h = buildOverlapping(new Harness());
  h.gw.incomingCall("c1", "sales");
  const b1 = h.branchOf("c1", "e1");

  h.gw.advanceTime(9_999);
  h.gw.report(b1, "answer");
  assert.equal(h.result("c1").status, "answered");

  h.gw.advanceTime(10_000);
  h.gw.advanceTime(99_999);
  assert.equal(h.result("c1").status, "answered", "已接听的来电不超时");
});

test("第一条振铃交付过程中立即回报接听：未交付预约不继续振铃、不泄漏名额", () => {
  const recorded: Action[] = [];
  let gw!: RingGateway;
  // 回调重入：第一条 ring 交付时直接接听
  const sink: ActionSink = (a) => {
    recorded.push(a);
    if (a.type === "ring" && a.extensionId === "e1") {
      gw.report(a.branchId, "answer");
    }
  };
  gw = new RingGateway(sink);
  gw.addExtension("e1", 2);
  gw.addExtension("e2", 2);
  gw.addRingGroup("g", ["e1", "e2"]);

  const r = gw.incomingCall("c1", "g");
  assert.equal(r.status, "answered");
  assert.equal(r.winner, "e1");
  assert.equal(recorded.filter((a) => a.type === "ring").length, 1, "e2 不应再收到振铃");
  assert.equal(gw.getExtensionUsage("e2")!.used, 0, "e2 的预约已退还，不泄漏名额");
  assert.equal(gw.getExtensionUsage("e1")!.used, 1);

  // 赢家结束通话后，名额全部释放
  gw.report(recorded[0].branchId, "lineEnd");
  assert.equal(gw.getExtensionUsage("e1")!.used, 0);

  // 每个分机都能再次接满配置容量（各 2 路）
  gw.incomingCall("c2", "g"); // e1 重入接听，e2 预约被退
  gw.incomingCall("c3", "g"); // e1 第二路
  assert.equal(gw.getExtensionUsage("e1")!.used, 2);
  gw.incomingCall("c4", "g"); // e1 已满 -> e2 振铃（sink 只自动接 e1）
  gw.incomingCall("c5", "g"); // e2 第二路
  assert.equal(gw.getExtensionUsage("e2")!.used, 2);
  assert.equal(gw.incomingCall("c6", "g").status, "busy", "两台分机都接满后忙线");
});

test("全部支路终止后每个分机都能再次接满配置容量", () => {
  const h = new Harness();
  h.gw.addExtension("e1", 2);
  h.gw.addExtension("e2", 1);
  h.gw.addRingGroup("g", ["e1", "e2"]);

  // 两通来电占满 e1(2) 与 e2(1)
  h.gw.incomingCall("c1", "g");
  h.gw.incomingCall("c2", "g");
  assert.equal(h.used("e1"), 2);
  assert.equal(h.used("e2"), 1);
  assert.equal(h.gw.incomingCall("c3", "g").status, "busy");

  // c1 无人接听：双方拒接 -> no-answer，名额全部释放
  h.gw.report(h.branchOf("c1", "e1"), "reject");
  h.gw.report(h.branchOf("c1", "e2"), "reject");
  assert.equal(h.result("c1").status, "no-answer");
  assert.equal(h.used("e1"), 1);
  assert.equal(h.used("e2"), 0);

  // c2 主叫结束：已交付支路撤销，终止后名额释放
  h.gw.callerHangup("c2");
  assert.equal(h.used("e1"), 1, "撤销途中仍占名额");
  h.gw.report(h.branchOf("c2", "e1"), "reject");
  assert.equal(h.result("c2").status, "no-answer");
  assert.equal(h.used("e1"), 0);
  assert.equal(h.used("e2"), 0);

  // 再次接满容量
  h.gw.incomingCall("c4", "g");
  h.gw.incomingCall("c5", "g");
  assert.equal(h.used("e1"), 2);
  assert.equal(h.used("e2"), 1);
});

test("旧支路事件不影响后来占用同一分机的通话", () => {
  const h = buildOverlapping(new Harness());
  h.gw.incomingCall("c1", "sales");
  const old = h.branchOf("c1", "e2");
  h.gw.report(h.branchOf("c1", "e1"), "answer"); // e2 被撤销
  h.gw.report(old, "reject"); // e2 名额释放

  h.gw.incomingCall("c2", "sales"); // e2 再次被占用
  assert.equal(h.used("e2"), 1);

  // 旧支路的迟到事件不得影响新通话
  h.gw.report(old, "answer");
  h.gw.report(old, "lineEnd");
  assert.equal(h.used("e2"), 1);
  assert.equal(h.count("hangup", old), 0, "已终止支路不再产生动作");
  assert.equal(h.result("c2").status, "ringing");
});

test("同一支路的振铃/撤销/挂断各至多交付一次（重复与交错回报）", () => {
  const h = buildOverlapping(new Harness());
  h.gw.incomingCall("c1", "sales");
  const b1 = h.branchOf("c1", "e1");
  const b2 = h.branchOf("c1", "e2");

  h.gw.report(b1, "answer");
  h.gw.report(b1, "answer"); // 重复接听
  h.gw.report(b2, "answer"); // 迟到接听 -> 挂断
  h.gw.report(b2, "answer"); // 重复迟到接听 -> 不再挂断
  h.gw.report(b2, "lineEnd");
  h.gw.report(b2, "lineEnd"); // 重复终止
  h.gw.report(b1, "lineEnd");

  assert.equal(h.count("ring", b1), 1);
  assert.equal(h.count("ring", b2), 1);
  assert.equal(h.count("cancel", b2), 1);
  assert.equal(h.count("hangup", b2), 1);
  assert.equal(h.count("hangup", b1), 0);
  assert.equal(h.used("e1"), 0);
  assert.equal(h.used("e2"), 0);
});

test("500 分机与重叠组：无回报支路不阻塞不相关组的新来电", () => {
  const h = new Harness();
  for (let i = 0; i < 500; i++) h.gw.addExtension(`ext${i}`, 2);
  // 100 个相互重叠的组
  for (let g = 0; g < 100; g++) {
    h.gw.addRingGroup(`g${g}`, [`ext${g}`, `ext${(g + 1) % 500}`, `ext${(g + 2) % 500}`]);
  }

  // 一条支路永远无回报
  h.gw.incomingCall("stuck", "g0");
  assert.equal(h.used("ext0"), 1);

  // 不相关组的新来电立即产出振铃
  const start = Date.now();
  let ringProduced = 0;
  for (let i = 0; i < 200; i++) {
    const r = h.gw.incomingCall(`call${i}`, `g${(i % 97) + 3}`);
    if (r.status === "ringing") ringProduced++;
  }
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 1000, `200 通来电处理耗时 ${elapsed}ms，应远小于 1s`);
  assert.ok(ringProduced > 0, "有空位时必须产出振铃动作");
  assert.equal(h.result("stuck").status, "ringing", "无回报支路保持等待");
});

test("默认容量为 2，容量边界校验", () => {
  const h = new Harness();
  h.gw.addExtension("e1");
  assert.equal(h.gw.getExtensionUsage("e1")!.capacity, 2);
  assert.throws(() => h.gw.addExtension("bad0", 0));
  assert.throws(() => h.gw.addExtension("bad9", 9));
  h.gw.addExtension("ok8", 8);
  assert.equal(h.gw.getExtensionUsage("ok8")!.capacity, 8);
});
