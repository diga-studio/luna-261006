import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RingGateway } from '../src/index.js';
import type { GatewayAction } from '../src/index.js';

function makeHarness() {
  const actions: GatewayAction[] = [];
  const gw = new RingGateway({ onAction: (a) => actions.push(a) });
  return { gw, actions };
}

// 验收场景1：重叠组争抢到容量上限；撤销未终止时名额不可用；
// 终止后可复用；重复投递旧终止回报不能挤出额外名额。
test('overlapping groups contend for shared capacity', () => {
  const { gw, actions } = makeHarness();
  // x 同时属于销售组和售后组，容量 1
  gw.registerExtension('x', 1);
  gw.registerExtension('salesOnly', 1);
  gw.registerExtension('supportOnly', 1);
  gw.registerGroup('sales', ['x', 'salesOnly']);
  gw.registerGroup('support', ['x', 'supportOnly']);

  // 第一通销售来电占满 x
  gw.incomingCall('c1', 'sales');
  assert.equal(gw.getExtensionUsage('x')?.occupied, 1);

  // 售后来电只能振 supportOnly，x 无余量
  gw.incomingCall('c2', 'support');
  const c2rings = actions.filter((a) => a.type === 'ring' && a.callId === 'c2');
  assert.deepEqual(c2rings.map((a) => a.extensionId), ['supportOnly']);

  // c1 的 x 支路被接听，c2 的 supportOnly 支路也被接听
  gw.reportAnswer('c1', 'x');
  gw.reportAnswer('c2', 'supportOnly');
  assert.equal(gw.getWinner('c1'), 'x');
  assert.equal(gw.getWinner('c2'), 'supportOnly');

  // c1 赢家挂线，x 名额释放
  gw.reportLineEnd('c1', 'x');
  assert.equal(gw.getExtensionUsage('x')?.occupied, 0);

  // c2 通话结束，supportOnly 名额释放
  gw.reportLineEnd('c2', 'supportOnly');
  assert.equal(gw.getExtensionUsage('supportOnly')?.occupied, 0);

  // 新的售后来电可以使用 x
  gw.incomingCall('c3', 'support');
  const c3rings = actions.filter((a) => a.type === 'ring' && a.callId === 'c3');
  assert.deepEqual(c3rings.map((a) => a.extensionId).sort(), ['supportOnly', 'x']);
});

test('cancel-pending branch still holds slot until termination report', () => {
  const { gw, actions } = makeHarness();
  gw.registerExtension('a', 1);
  gw.registerExtension('b', 1);
  gw.registerGroup('g1', ['a', 'b']);
  gw.registerGroup('g2', ['a']);

  gw.incomingCall('c1', 'g1');
  // b 接听，a 支路被撤销
  gw.reportAnswer('c1', 'b');
  assert.equal(actions.filter((a) => a.type === 'cancel' && a.callId === 'c1').length, 1);

  // 撤销尚未终止，a 的名额仍被占用，新来电直接忙线
  assert.equal(gw.getExtensionUsage('a')?.occupied, 1);
  const r = gw.incomingCall('c2', 'g2');
  assert.deepEqual(r, { status: 'busy' });

  // 终止回报到达后名额可复用
  gw.reportLineEnd('c1', 'a');
  assert.equal(gw.getExtensionUsage('a')?.occupied, 0);
  const r3 = gw.incomingCall('c3', 'g2');
  assert.equal(r3.status, 'ringing');
  assert.equal(gw.getExtensionUsage('a')?.occupied, 1);

  // 重复投递旧终止回报不能挤出额外名额
  gw.reportLineEnd('c1', 'a');
  gw.reportReject('c1', 'a');
  assert.equal(gw.getExtensionUsage('a')?.occupied, 1);
  // c3 支路不受影响
  assert.equal(gw.getCallResult('c3')?.status, 'ringing');
});

test('old branch events do not affect later calls on same extension', () => {
  const { gw, actions } = makeHarness();
  gw.registerExtension('a', 1);
  gw.registerGroup('g', ['a']);

  gw.incomingCall('c1', 'g');
  gw.callerHangup('c1'); // a 支路 -> cancelPending，名额仍占用
  assert.equal(gw.getExtensionUsage('a')?.occupied, 1);
  gw.reportLineEnd('c1', 'a'); // 终止，名额释放
  assert.equal(gw.getExtensionUsage('a')?.occupied, 0);

  // 新来电占用同一分机
  gw.incomingCall('c2', 'g');
  assert.equal(gw.getExtensionUsage('a')?.occupied, 1);

  // 旧来电的迟到事件不得影响 c2
  gw.reportAnswer('c1', 'a');
  gw.reportLineEnd('c1', 'a');
  gw.reportReject('c1', 'a');
  assert.equal(gw.getCallResult('c2')?.status, 'ringing');
  assert.equal(gw.getExtensionUsage('a')?.occupied, 1);
  assert.equal(actions.filter((x) => x.callId === 'c1' && x.type === 'hangup').length, 0);
});
