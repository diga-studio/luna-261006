import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RingGateway } from '../src/index.js';
import type { GatewayAction, GatewayOptions } from '../src/index.js';

interface Harness {
  gw: RingGateway;
  actions: GatewayAction[];
}

function makeHarness(options?: Partial<GatewayOptions>): Harness {
  const actions: GatewayAction[] = [];
  const gw = new RingGateway({
    onAction: (a) => actions.push(a),
    ...options,
  });
  return { gw, actions };
}

function rings(actions: GatewayAction[], callId: string) {
  return actions.filter((a) => a.type === 'ring' && a.callId === callId);
}

function cancels(actions: GatewayAction[], callId: string) {
  return actions.filter((a) => a.type === 'cancel' && a.callId === callId);
}

function hangups(actions: GatewayAction[], callId: string) {
  return actions.filter((a) => a.type === 'hangup' && a.callId === callId);
}

test('registers extensions with default capacity 2 and validates range', () => {
  const { gw } = makeHarness();
  gw.registerExtension('e1');
  assert.equal(gw.getExtensionUsage('e1')?.capacity, 2);
  assert.throws(() => gw.registerExtension('bad', 0), RangeError);
  assert.throws(() => gw.registerExtension('bad', 9), RangeError);
  assert.throws(() => gw.registerExtension('bad', 1.5), RangeError);
  gw.registerExtension('e2', 8);
  assert.equal(gw.getExtensionUsage('e2')?.capacity, 8);
  assert.throws(() => gw.registerExtension('e1'), /already registered/);
  assert.equal(gw.getExtensionUsage('unknown'), undefined);
});

test('group requires known extensions and dedupes members', () => {
  const { gw } = makeHarness();
  gw.registerExtension('a');
  gw.registerExtension('b');
  assert.throws(() => gw.registerGroup('g', ['a', 'nope']), /unknown extension/);
  gw.registerGroup('g', ['a', 'b', 'a']);
  const r = gw.incomingCall('c1', 'g');
  assert.equal(r.status, 'ringing');
  assert.equal(gw.getExtensionUsage('a')?.occupied, 1);
  assert.equal(gw.getExtensionUsage('b')?.occupied, 1);
});

test('basic call: ring all members, first answer wins, losers cancelled', () => {
  const { gw, actions } = makeHarness();
  gw.registerExtension('a');
  gw.registerExtension('b');
  gw.registerGroup('g', ['a', 'b']);
  const r = gw.incomingCall('c1', 'g');
  assert.equal(r.status, 'ringing');
  assert.deepEqual(rings(actions, 'c1').map((a) => a.extensionId), ['a', 'b']);

  gw.reportAnswer('c1', 'b');
  assert.equal(gw.getWinner('c1'), 'b');
  assert.deepEqual(gw.getCallResult('c1'), { status: 'established', winner: 'b' });
  assert.deepEqual(cancels(actions, 'c1').map((a) => a.extensionId), ['a']);

  // a 的名额仍被撤销中的支路占用
  assert.equal(gw.getExtensionUsage('a')?.occupied, 1);
  gw.reportLineEnd('c1', 'a');
  assert.equal(gw.getExtensionUsage('a')?.occupied, 0);

  // 赢家线路结束 -> 整通来电结束
  gw.reportLineEnd('c1', 'b');
  assert.deepEqual(gw.getCallResult('c1'), { status: 'answered-ended', winner: 'b' });
  assert.equal(gw.getExtensionUsage('b')?.occupied, 0);
});

test('busy when all members full, no actions emitted', () => {
  const { gw, actions } = makeHarness();
  gw.registerExtension('a', 1);
  gw.registerGroup('g', ['a']);
  gw.incomingCall('c1', 'g');
  const r = gw.incomingCall('c2', 'g');
  assert.deepEqual(r, { status: 'busy' });
  assert.equal(rings(actions, 'c2').length, 0);
  assert.deepEqual(gw.getCallResult('c2'), { status: 'busy' });
});

test('duplicate call id and unknown group rejected', () => {
  const { gw } = makeHarness();
  gw.registerExtension('a');
  gw.registerGroup('g', ['a']);
  gw.incomingCall('c1', 'g');
  assert.throws(() => gw.incomingCall('c1', 'g'), /duplicate/);
  assert.throws(() => gw.incomingCall('c2', 'nope'), /unknown group/);
});

test('unknown call/extension reports are ignored', () => {
  const { gw } = makeHarness();
  gw.registerExtension('a');
  gw.registerGroup('g', ['a']);
  gw.reportAnswer('nope', 'a');
  gw.reportReject('nope', 'a');
  gw.reportLineEnd('nope', 'a');
  gw.callerHangup('nope');
  gw.incomingCall('c1', 'g');
  gw.reportAnswer('c1', 'stranger');
  assert.equal(gw.getCallResult('c1')?.status, 'ringing');
});
