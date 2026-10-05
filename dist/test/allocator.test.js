"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const index_js_1 = require("../src/index.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 可控执行器：每次调用返回一个可手动了结的 Promise。 */
function controllableExecutor() {
    const calls = [];
    const executor = (targetId, signal) => new Promise((resolve) => {
        calls.push({ targetId, signal, resolve });
    });
    return { calls, executor };
}
const FAST = { attemptTimeoutMs: 50, retryDelaysMs: [20, 30], maxAttempts: 3 };
(0, node_test_1.default)("上限为1的目标超时未结束时被移除再加入，不能提前接收新尝试，真正结束后才能重新分配", async () => {
    const { calls, executor } = controllableExecutor();
    const alloc = new index_js_1.Allocator(executor, FAST);
    alloc.replaceConfig([{ id: "a", maxConcurrency: 1 }]);
    const req1 = alloc.submit();
    strict_1.default.equal(calls.length, 1);
    strict_1.default.equal(calls[0].targetId, "a");
    // 执行器未结束时移除目标。
    alloc.replaceConfig([]);
    // 等待尝试超时（50ms）并进入重试等待。
    await sleep(70);
    strict_1.default.equal(calls[0].signal.cancelled, true);
    // 同标识目标重新加入，但旧尝试占用仍在。
    alloc.replaceConfig([{ id: "a", maxConcurrency: 1 }]);
    strict_1.default.deepEqual(alloc.occupancy(), [
        { targetId: "a", inFlight: 1, maxConcurrency: 1 },
    ]);
    // 重试时刻到来：唯一目标仍被旧尝试占满，请求立即以无可用目标结束。
    const result1 = await req1.result;
    strict_1.default.deepEqual(result1, { status: "no-available-target" });
    strict_1.default.equal(calls.length, 1, "占用未释放前不得新增尝试");
    // 旧执行器真正结束后，占用释放，目标可重新分配。
    calls[0].resolve("success");
    await sleep(1);
    strict_1.default.deepEqual(alloc.occupancy(), [
        { targetId: "a", inFlight: 0, maxConcurrency: 1 },
    ]);
    const req2 = alloc.submit();
    strict_1.default.equal(calls.length, 2);
    strict_1.default.equal(calls[1].targetId, "a");
    calls[1].resolve("success");
    strict_1.default.deepEqual(await req2.result, { status: "success" });
});
(0, node_test_1.default)("重试等待期间取消：立即结束等待、取消未结束尝试、阻止未开始的重试", async () => {
    const { calls, executor } = controllableExecutor();
    const alloc = new index_js_1.Allocator(executor, {
        attemptTimeoutMs: 1000,
        retryDelaysMs: [200, 400],
        maxAttempts: 3,
    });
    alloc.replaceConfig([
        { id: "a", maxConcurrency: 1 },
        { id: "b", maxConcurrency: 1 },
    ]);
    const req = alloc.submit();
    strict_1.default.equal(calls.length, 1);
    // 第一次尝试失败，进入 200ms 重试等待。
    calls[0].resolve("failure");
    await sleep(50);
    // 重试等待期间取消。
    req.cancel();
    strict_1.default.deepEqual(await req.result, { status: "cancelled" });
    // 等过重试时刻，确认没有新尝试发生。
    await sleep(300);
    strict_1.default.equal(calls.length, 1, "取消后不得再发起重试");
});
(0, node_test_1.default)("旧尝试晚于新尝试成功才返回：最终结果唯一且不触发额外重试", async () => {
    const { calls, executor } = controllableExecutor();
    const alloc = new index_js_1.Allocator(executor, FAST);
    alloc.replaceConfig([
        { id: "a", maxConcurrency: 1 },
        { id: "b", maxConcurrency: 1 },
    ]);
    const req = alloc.submit();
    // 第一次尝试在 "a"（字典序优先），保持 pending 直到超时。
    strict_1.default.equal(calls[0].targetId, "a");
    await sleep(60); // 超时发生，进入 20ms 重试等待
    await sleep(30); // 第二次尝试已在 "b" 上开始
    strict_1.default.equal(calls.length, 2);
    strict_1.default.equal(calls[1].targetId, "b");
    // 新尝试成功，请求成功。
    calls[1].resolve("success");
    strict_1.default.deepEqual(await req.result, { status: "success" });
    // 旧尝试迟到成功：只释放占用，不改变结果、不触发额外重试。
    calls[0].resolve("success");
    await sleep(50);
    strict_1.default.equal(calls.length, 2, "迟到的结果不得触发额外重试");
    strict_1.default.deepEqual(alloc.occupancy(), [
        { targetId: "a", inFlight: 0, maxConcurrency: 1 },
        { targetId: "b", inFlight: 0, maxConcurrency: 1 },
    ]);
});
(0, node_test_1.default)("选择占用最少的目标，并列时按标识字典序", async () => {
    const { calls, executor } = controllableExecutor();
    const alloc = new index_js_1.Allocator(executor, FAST);
    alloc.replaceConfig([
        { id: "b", maxConcurrency: 2 },
        { id: "a", maxConcurrency: 2 },
    ]);
    alloc.submit(); // 并列 -> "a"
    alloc.submit(); // "a"=1, "b"=0 -> "b"
    alloc.submit(); // 1:1 并列 -> "a"
    strict_1.default.deepEqual(calls.map((c) => c.targetId), ["a", "b", "a"]);
});
(0, node_test_1.default)("全部尝试失败后请求失败，且同一请求不重复选择已尝试目标", async () => {
    const { calls, executor } = controllableExecutor();
    const alloc = new index_js_1.Allocator(executor, {
        attemptTimeoutMs: 1000,
        retryDelaysMs: [10, 10],
        maxAttempts: 3,
    });
    alloc.replaceConfig([
        { id: "a", maxConcurrency: 5 },
        { id: "b", maxConcurrency: 5 },
        { id: "c", maxConcurrency: 5 },
    ]);
    const req = alloc.submit();
    for (let i = 0; i < 3; i += 1) {
        await sleep(30);
        calls[i].resolve("failure");
    }
    strict_1.default.deepEqual(await req.result, { status: "failure" });
    strict_1.default.equal(calls.length, 3);
    strict_1.default.deepEqual(calls.map((c) => c.targetId), ["a", "b", "c"]);
});
(0, node_test_1.default)("无符合条件目标时立即以无可用目标结束", async () => {
    const { executor } = controllableExecutor();
    const alloc = new index_js_1.Allocator(executor, FAST);
    const result = await alloc.submit().result;
    strict_1.default.deepEqual(result, { status: "no-available-target" });
});
(0, node_test_1.default)("查询包含已移除但仍有占用的目标", async () => {
    const { calls, executor } = controllableExecutor();
    const alloc = new index_js_1.Allocator(executor, FAST);
    alloc.replaceConfig([{ id: "a", maxConcurrency: 1 }]);
    alloc.submit();
    alloc.replaceConfig([]);
    strict_1.default.deepEqual(alloc.occupancy(), [
        { targetId: "a", inFlight: 1, maxConcurrency: null },
    ]);
    calls[0].resolve("failure");
    await sleep(1);
    strict_1.default.deepEqual(alloc.occupancy(), []);
});
(0, node_test_1.default)("降低上限不终止已有尝试，占用降到新上限以下前不得新增尝试", async () => {
    const { calls, executor } = controllableExecutor();
    const alloc = new index_js_1.Allocator(executor, {
        attemptTimeoutMs: 1000,
        retryDelaysMs: [10, 10],
        maxAttempts: 1,
    });
    alloc.replaceConfig([{ id: "a", maxConcurrency: 2 }]);
    alloc.submit();
    alloc.submit();
    strict_1.default.equal(calls.length, 2);
    // 上限降为 1：已有 2 个尝试继续运行。
    alloc.replaceConfig([{ id: "a", maxConcurrency: 1 }]);
    const req3 = alloc.submit();
    strict_1.default.deepEqual(await req3.result, { status: "no-available-target" });
    strict_1.default.equal(calls.length, 2);
    // 释放一个后占用为 1，仍不低于新上限 1，不可新增。
    calls[0].resolve("success");
    await sleep(1);
    const req4 = alloc.submit();
    strict_1.default.deepEqual(await req4.result, { status: "no-available-target" });
    // 再释放一个后占用为 0，可重新分配。
    calls[1].resolve("success");
    await sleep(1);
    const req5 = alloc.submit();
    strict_1.default.equal(calls.length, 3);
    calls[2].resolve("success");
    strict_1.default.deepEqual(await req5.result, { status: "success" });
});
(0, node_test_1.default)("客户端取消进行中的尝试：信号发出且结果唯一", async () => {
    const { calls, executor } = controllableExecutor();
    const alloc = new index_js_1.Allocator(executor, FAST);
    alloc.replaceConfig([{ id: "a", maxConcurrency: 1 }]);
    const req = alloc.submit();
    req.cancel();
    strict_1.default.equal(calls[0].signal.cancelled, true);
    const first = await req.result;
    strict_1.default.deepEqual(first, { status: "cancelled" });
    // 取消后执行器迟到成功，不改变结果。
    calls[0].resolve("success");
    await sleep(20);
    strict_1.default.equal(calls.length, 1);
});
(0, node_test_1.default)("非法配置被拒绝", async () => {
    const { executor } = controllableExecutor();
    const alloc = new index_js_1.Allocator(executor, FAST);
    strict_1.default.throws(() => alloc.replaceConfig([
        { id: "a", maxConcurrency: 1 },
        { id: "a", maxConcurrency: 2 },
    ]));
    strict_1.default.throws(() => alloc.replaceConfig([{ id: "a", maxConcurrency: 0 }]));
});
