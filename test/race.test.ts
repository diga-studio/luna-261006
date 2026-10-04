import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RingGateway } from '../src/index.js';
import type { GatewayAction } from '../src/index.js';

function makeHarness(ringTimeoutMs = 10_000) {
  const actions: GatewayAction[] = [];
  const gw = new RingGateway({ onAction: (a) => actions.push(a), ringTimeoutMs });
  return { gw, actions };
}

const ofType = (actions: GatewayAction[], type: string, callId: string) =>
  actions.filter((a) => a.type === type && a.callId === callId);

// 验收场景2a：两条支路交错接听，始终最多一个赢家
test('interleaved answers: exactly one winner, loser gets hangup', () => {
  const { gw, actions } = makeHarness();
  gw.registerExtension('a');
  gw.registerExtension('b');
  gw.registerGroup('g', ['a', 'b']);
  gw.incomingCall('c1', 'g');

  gw.reportAnswer('c1', 'a');
  // b 的撤销已发出但尚未终止时，b 也报告接听（交错）
  gw.reportAnswer('c1', 'b');

  assert.equal(gw.getWinner('c1'), 'a');
  // b 迟到接听 -> 收到挂断，不是赢家
  assert.equal(ofType(actions, 'hangup', 'c1').length, 1);
  assert.deepEqual(ofType(actions, 'hangup', 'c1')[0], { type: 'hangup', callId: 'c1', extensionId: 'b' });
  // b 支路挂断后名额仍占用，直到线路结束回报
  assert.equal(gw.getExtensionUsage('b')?.occupied, 1);
  gw.reportLineEnd('c1', 'b');
  assert.equal(gw.getExtensionUsage('b')?.occupied, 0);

  // 重复接听报告不再产生动作
  gw.reportAnswer('c1', 'b');
  gw.reportAnswer('c1', 'a');
  assert.equal(ofType(actions, 'hangup', 'c1').length, 1);
  assert.equal(gw.getWinner('c1'), 'a');
});

// 验收场景2b：接听恰逢超时边界（当前业务时间等于截止时刻算超时）
test('answer at exact timeout boundary loses to timeout', () => {
  const { gw, actions } = makeHarness();
  gw.registerExtension('a');
  gw.registerGroup('g', ['a']);
  gw.advanceTime(5_000);
  gw.incomingCall('c1', 'g'); // 截止时刻 15_000

  // 推进到恰好截止时刻 -> 超时
  gw.advanceTime(15_000);
  assert.deepEqual(gw.getCallResult('c1'), { status: 'unanswered' });
  assert.equal(ofType(actions, 'cancel', 'c1').length, 1);

  // 超时后的接听不得建立通话；撤销途中接听 -> 另发挂断
  gw.reportAnswer('c1', 'a');
  assert.equal(gw.getWinner('c1'), undefined);
  assert.deepEqual(gw.getCallResult('c1'), { status: 'unanswered' });
  assert.equal(ofType(actions, 'hangup', 'c1').length, 1);
  // 名额未释放，直到线路结束回报
  assert.equal(gw.getExtensionUsage('a')?.occupied, 1);
  gw.reportLineEnd('c1', 'a');
  assert.equal(gw.getExtensionUsage('a')?.occupied, 0);
});

test('answer just before deadline wins, timeout does not apply after winner', () => {
  const { gw, actions } = makeHarness();
  gw.registerExtension('a');
  gw.registerGroup('g', ['a']);
  gw.incomingCall('c1', 'g'); // 截止 10_000

  gw.advanceTime(9_999);
  gw.reportAnswer('c1', 'a');
  assert.equal(gw.getWinner('c1'), 'a');

  // 已有赢家的来电不再超时
  gw.advanceTime(10_000);
  gw.advanceTime(99_999);
  assert.deepEqual(gw.getCallResult('c1'), { status: 'established', winner: 'a' });
  assert.equal(ofType(actions, 'cancel', 'c1').length + ofType(actions, 'hangup', 'c1').length, 0);
});

// 验收场景2c：被撤销支路迟到接听会收到挂断，但来电不会复活
test('late answer on cancelled branch gets hangup, call does not revive', () => {
  const { gw, actions } = makeHarness();
  gw.registerExtension('a');
  gw.registerExtension('b');
  gw.registerGroup('g', ['a', 'b']);
  gw.incomingCall('c1', 'g');

  // 来电方结束 -> 两支路均被撤销
  gw.callerHangup('c1');
  assert.equal(ofType(actions, 'cancel', 'c1').length, 2);
  assert.deepEqual(gw.getCallResult('c1'), { status: 'unanswered' });

  // a 支路终止
  gw.reportLineEnd('c1', 'a');
  // b 支路迟到接听 -> 挂断，不复活
  gw.reportAnswer('c1', 'b');
  assert.equal(gw.getWinner('c1'), undefined);
  assert.deepEqual(gw.getCallResult('c1'), { status: 'unanswered' });
  assert.equal(ofType(actions, 'hangup', 'c1').length, 1);

  // b 挂断完成，名额释放；此后 b 的旧事件不再有影响
  gw.reportLineEnd('c1', 'b');
  assert.equal(gw.getExtensionUsage('b')?.occupied, 0);
  gw.reportAnswer('c1', 'b');
  assert.equal(ofType(actions, 'hangup', 'c1').length, 1);
  assert.deepEqual(gw.getCallResult('c1'), { status: 'unanswered' });
});

test('winner line end ends call; other pending branches unaffected until reported', () => {
  const { gw, actions } = makeHarness();
  gw.registerExtension('a');
  gw.registerExtension('b');
  gw.registerGroup('g', ['a', 'b']);
  gw.incomingCall('c1', 'g');
  gw.reportAnswer('c1', 'a'); // a 赢家，b 被撤销
  gw.reportLineEnd('c1', 'a'); // 赢家线路结束 -> 整通结束
  assert.deepEqual(gw.getCallResult('c1'), { status: 'answered-ended', winner: 'a' });

  // b 支路仍等待终止，名额仍占用；之后迟到接听 -> 挂断
  assert.equal(gw.getExtensionUsage('b')?.occupied, 1);
  gw.reportAnswer('c1', 'b');
  assert.equal(ofType(actions, 'hangup', 'c1').length, 1);
  assert.equal(gw.getWinner('c1'), 'a'); // 不改选赢家
  gw.reportLineEnd('c1', 'b');
  assert.equal(gw.getExtensionUsage('b')?.occupied, 0);
});

test('unanswered when all branches reject', () => {
  const { gw } = makeHarness();
  gw.registerExtension('a');
  gw.registerExtension('b');
  gw.registerGroup('g', ['a', 'b']);
  gw.incomingCall('c1', 'g');
  gw.reportReject('c1', 'a');
  assert.equal(gw.getCallResult('c1')?.status, 'ringing');
  gw.reportReject('c1', 'b');
  assert.deepEqual(gw.getCallResult('c1'), { status: 'unanswered' });
  assert.equal(gw.getExtensionUsage('a')?.occupied, 0);
  assert.equal(gw.getExtensionUsage('b')?.occupied, 0);
});

test('backward time is rejected', () => {
  const { gw } = makeHarness();
  gw.advanceTime(100);
  assert.throws(() => gw.advanceTime(99), RangeError);
});

test('caller hangup after answer hangs up winner, slot held until line end', () => {
  const { gw, actions } = makeHarness();
  gw.registerExtension('a', 1);
  gw.registerGroup('g', ['a']);
  gw.incomingCall('c1', 'g');
  gw.reportAnswer('c1', 'a');
  gw.callerHangup('c1');
  assert.deepEqual(gw.getCallResult('c1'), { status: 'answered-ended', winner: 'a' });
  assert.equal(ofType(actions, 'hangup', 'c1').length, 1);
  // 挂断未确认前名额仍占用，新来电忙线
  assert.equal(gw.getExtensionUsage('a')?.occupied, 1);
  assert.deepEqual(gw.incomingCall('c2', 'g'), { status: 'busy' });
  gw.reportLineEnd('c1', 'a');
  assert.equal(gw.getExtensionUsage('a')?.occupied, 0);
  // 重复结束来电无效果
  gw.callerHangup('c1');
  assert.equal(ofType(actions, 'hangup', 'c1').length, 1);
});
