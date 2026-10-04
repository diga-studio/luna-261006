import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RingGateway } from '../src/index.js';
import type { GatewayAction } from '../src/index.js';

const ofType = (actions: GatewayAction[], type: string, callId: string) =>
  actions.filter((a) => a.type === type && a.callId === callId);

// 验收场景3：第一条振铃在交付过程中立即回报接听，
// 其他未交付预约不得继续振铃或泄漏名额；
// 全部支路最终终止后，每个分机都能再次接满其配置容量。
test('reentrant answer during first ring delivery stops remaining rings', () => {
  const actions: GatewayAction[] = [];
  let gw: RingGateway;
  const onAction = (a: GatewayAction) => {
    actions.push(a);
    // 第一条振铃交付过程中（回调返回前）立即回报接听
    if (a.type === 'ring' && a.extensionId === 'e1') {
      gw.reportAnswer('c1', 'e1');
    }
  };
  gw = new RingGateway({ onAction });
  for (const id of ['e1', 'e2', 'e3']) gw.registerExtension(id, 2);
  gw.registerGroup('g', ['e1', 'e2', 'e3']);

  const r = gw.incomingCall('c1', 'g');
  assert.deepEqual(r, { status: 'established', winner: 'e1' });
  assert.equal(gw.getWinner('c1'), 'e1');

  // e2/e3 的预约被作废：没有振铃、没有撤销，名额已退还
  assert.deepEqual(ofType(actions, 'ring', 'c1').map((a) => a.extensionId), ['e1']);
  assert.equal(ofType(actions, 'cancel', 'c1').length, 0);
  assert.equal(gw.getExtensionUsage('e2')?.occupied, 0);
  assert.equal(gw.getExtensionUsage('e3')?.occupied, 0);
  assert.equal(gw.getExtensionUsage('e1')?.occupied, 1);

  // 赢家线路结束，全部支路终止后，每个分机都能再次接满容量 2
  gw.reportLineEnd('c1', 'e1');
  assert.equal(gw.getExtensionUsage('e1')?.occupied, 0);
  gw.incomingCall('c2', 'g');
  gw.incomingCall('c3', 'g');
  for (const id of ['e1', 'e2', 'e3']) {
    assert.equal(gw.getExtensionUsage(id)?.occupied, 2, `${id} should be full again`);
  }
  // 容量已满，再来电直接忙线
  assert.deepEqual(gw.incomingCall('c4', 'g'), { status: 'busy' });
});

test('reentrant reject during ring delivery terminates branch immediately', () => {
  const actions: GatewayAction[] = [];
  let gw: RingGateway;
  const onAction = (a: GatewayAction) => {
    actions.push(a);
    if (a.type === 'ring' && a.extensionId === 'e1') {
      gw.reportReject('c1', 'e1');
    }
  };
  gw = new RingGateway({ onAction });
  gw.registerExtension('e1', 1);
  gw.registerExtension('e2', 1);
  gw.registerGroup('g', ['e1', 'e2']);

  gw.incomingCall('c1', 'g');
  // e1 在回调内拒接，名额当场释放；e2 正常振铃
  assert.equal(gw.getExtensionUsage('e1')?.occupied, 0);
  assert.equal(gw.getCallResult('c1')?.status, 'ringing');
  assert.deepEqual(ofType(actions, 'ring', 'c1').map((a) => a.extensionId), ['e1', 'e2']);
});

test('reentrant caller hangup during ring delivery stops remaining rings', () => {
  const actions: GatewayAction[] = [];
  let gw: RingGateway;
  const onAction = (a: GatewayAction) => {
    actions.push(a);
    if (a.type === 'ring' && a.extensionId === 'e1') {
      gw.callerHangup('c1');
    }
  };
  gw = new RingGateway({ onAction });
  gw.registerExtension('e1', 1);
  gw.registerExtension('e2', 1);
  gw.registerGroup('g', ['e1', 'e2']);

  const r = gw.incomingCall('c1', 'g');
  assert.deepEqual(r, { status: 'unanswered' });
  // e2 未交付的预约被退还，不再振铃
  assert.deepEqual(ofType(actions, 'ring', 'c1').map((a) => a.extensionId), ['e1']);
  assert.equal(gw.getExtensionUsage('e2')?.occupied, 0);
  // e1 支路撤销中，名额仍占用
  assert.equal(ofType(actions, 'cancel', 'c1').length, 1);
  assert.equal(gw.getExtensionUsage('e1')?.occupied, 1);
  gw.reportLineEnd('c1', 'e1');
  assert.equal(gw.getExtensionUsage('e1')?.occupied, 0);
});

test('reentrant answer for a later-rung branch during cancel callback gets hangup', () => {
  const actions: GatewayAction[] = [];
  let gw: RingGateway;
  const onAction = (a: GatewayAction) => {
    actions.push(a);
    // a 接听成为赢家后，网关向 b 发撤销；撤销回调内 b 也报告接听
    if (a.type === 'cancel' && a.callId === 'c1' && a.extensionId === 'e2') {
      gw.reportAnswer('c1', 'e2');
    }
  };
  gw = new RingGateway({ onAction });
  gw.registerExtension('e1', 1);
  gw.registerExtension('e2', 1);
  gw.registerGroup('g', ['e1', 'e2']);

  gw.incomingCall('c1', 'g');
  gw.reportAnswer('c1', 'e1');
  assert.equal(gw.getWinner('c1'), 'e1');
  // e2 在撤销回调内接听 -> 收到挂断，且挂断只发一次
  assert.equal(ofType(actions, 'hangup', 'c1').length, 1);
  assert.deepEqual(ofType(actions, 'hangup', 'c1')[0], { type: 'hangup', callId: 'c1', extensionId: 'e2' });
  // 撤销与挂断各至多一次
  assert.equal(ofType(actions, 'cancel', 'c1').length, 1);
  gw.reportLineEnd('c1', 'e2');
  assert.equal(gw.getExtensionUsage('e2')?.occupied, 0);
});
