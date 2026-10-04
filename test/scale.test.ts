import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RingGateway } from '../src/index.js';
import type { GatewayAction } from '../src/index.js';

// 非功能验收：500 个分机及相互重叠的振铃组；
// 一条支路一直没有回报，不相关组的新来电仍须立即产出振铃动作。
test('500 extensions with overlapping groups; stuck branch does not block others', () => {
  const actions: GatewayAction[] = [];
  const gw = new RingGateway({ onAction: (a) => actions.push(a) });

  const EXT_COUNT = 500;
  const GROUP_COUNT = 100;
  for (let i = 0; i < EXT_COUNT; i++) gw.registerExtension(`e${i}`, 8);
  // 每个组 10 个分机，相邻组重叠一半成员
  for (let g = 0; g < GROUP_COUNT; g++) {
    const members = Array.from({ length: 10 }, (_, k) => `e${(g * 5 + k) % EXT_COUNT}`);
    gw.registerGroup(`g${g}`, members);
  }

  // 制造一条永远不回报的支路：c-stuck 在组 g0 振铃后无人应答也不终止
  gw.incomingCall('c-stuck', 'g0');
  const stuckRings = actions.filter((a) => a.type === 'ring' && a.callId === 'c-stuck');
  assert.equal(stuckRings.length, 10);

  // 不相关组的新来电必须照常产出振铃
  const start = performance.now();
  const CALLS = 200;
  for (let i = 0; i < CALLS; i++) {
    const r = gw.incomingCall(`c${i}`, `g${(i % (GROUP_COUNT - 1)) + 1}`);
    assert.equal(r.status, 'ringing');
  }
  const elapsed = performance.now() - start;
  const newRings = actions.filter((a) => a.type === 'ring' && a.callId !== 'c-stuck');
  assert.equal(newRings.length, CALLS * 10);
  assert.ok(elapsed < 1000, `expected well under 1s, took ${elapsed}ms`);

  // 卡住的支路仍占着名额（e0 还被其他重叠组使用，占用只会更多）
  assert.ok((gw.getExtensionUsage('e0')?.occupied ?? 0) >= 1);
  assert.equal(gw.getCallResult('c-stuck')?.status, 'ringing');

  // 占用不变式：所有分机占用不超过容量、不为负
  for (let i = 0; i < EXT_COUNT; i++) {
    const u = gw.getExtensionUsage(`e${i}`)!;
    assert.ok(u.occupied >= 0 && u.occupied <= u.capacity, `e${i} occupancy invariant`);
    assert.equal(u.available, u.capacity - u.occupied);
  }
});

test('mass interleaved answers keep at most one winner per call', () => {
  const actions: GatewayAction[] = [];
  const gw = new RingGateway({ onAction: (a) => actions.push(a) });
  for (let i = 0; i < 50; i++) gw.registerExtension(`e${i}`, 8);
  gw.registerGroup('g', Array.from({ length: 50 }, (_, i) => `e${i}`));

  for (let c = 0; c < 20; c++) {
    const callId = `c${c}`;
    gw.incomingCall(callId, 'g');
    // 所有分机交错回报接听
    for (let i = 0; i < 50; i++) gw.reportAnswer(callId, `e${i}`);
    // 恰好一个赢家
    const winner = gw.getWinner(callId);
    assert.equal(winner, 'e0');
    // 每个分机：振铃至多一次，撤销+挂断合计至多一次
    for (let i = 0; i < 50; i++) {
      const rings = actions.filter((a) => a.callId === callId && a.extensionId === `e${i}` && a.type === 'ring');
      const cancels = actions.filter((a) => a.callId === callId && a.extensionId === `e${i}` && a.type === 'cancel');
      const hangups = actions.filter((a) => a.callId === callId && a.extensionId === `e${i}` && a.type === 'hangup');
      assert.ok(rings.length <= 1);
      assert.ok(cancels.length <= 1);
      assert.ok(hangups.length <= 1);
    }
    // 清理：赢家挂线，其余回报线路结束
    gw.reportLineEnd(callId, 'e0');
    for (let i = 1; i < 50; i++) gw.reportLineEnd(callId, `e${i}`);
    for (let i = 0; i < 50; i++) {
      assert.equal(gw.getExtensionUsage(`e${i}`)?.occupied, 0, `e${i} leaked slot after call ${callId}`);
    }
  }
});
