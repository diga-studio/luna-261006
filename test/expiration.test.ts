import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalService, ROUND_DURATION_MS } from '../src/index.js';

const T0 = 1_000_000_000_000;
const H = ROUND_DURATION_MS;

function svc(): ApprovalService {
  return new ApprovalService(':memory:');
}

test('普通轮部分签署后恰好到期：切换到升级轮，已有同意被清空', () => {
  const s = svc();
  s.submitTicket({
    ticketId: 't',
    stages: [{ approvers: ['a', 'b'], escalatedApprovers: ['x', 'y'] }],
    now: T0,
  });
  s.submitDecision({
    ticketId: 't', stageIndex: 0, round: 'normal',
    approver: 'a', decisionId: 'd1', approve: true, now: T0 + 1000,
  });
  // 恰好在截止时刻查看：先落实到期
  const view = s.getTicket('t', T0 + H);
  assert.equal(view.status, 'pending');
  assert.equal(view.currentRound, 'escalated');
  assert.deepEqual(view.agreedApprovers, []);
  // 升级轮从普通轮原截止时刻起算 24 小时
  assert.equal(view.deadline, T0 + 2 * H);
  s.close();
});

test('截止时刻同一毫秒：先处理到期，普通轮最后一票不能补齐会签', () => {
  const s = svc();
  s.submitTicket({
    ticketId: 't',
    stages: [{ approvers: ['a', 'b'], escalatedApprovers: ['x'] }],
    now: T0,
  });
  s.submitDecision({
    ticketId: 't', stageIndex: 0, round: 'normal',
    approver: 'a', decisionId: 'd1', approve: true, now: T0 + H - 1,
  });
  // 最后一票恰好打在截止时刻：到期先发生，该票成为旧轮迟到决定
  const r = s.submitDecision({
    ticketId: 't', stageIndex: 0, round: 'normal',
    approver: 'b', decisionId: 'd2', approve: true, now: T0 + H,
  });
  assert.equal(r.conclusion, 'stale-round');
  assert.equal(r.ticketStatus, 'pending');
  const view = s.getTicket('t', T0 + H);
  assert.equal(view.currentRound, 'escalated');
  assert.deepEqual(view.agreedApprovers, []);
  s.close();
});

test('升级轮到期仍未完成：整单超时结束', () => {
  const s = svc();
  s.submitTicket({
    ticketId: 't',
    stages: [{ approvers: ['a'], escalatedApprovers: ['x'] }],
    now: T0,
  });
  s.advanceTime(T0 + H); // 进入升级轮
  assert.equal(s.getTicket('t', T0 + H).currentRound, 'escalated');
  s.advanceTime(T0 + 2 * H); // 升级轮也到期
  const view = s.getTicket('t', T0 + 2 * H);
  assert.equal(view.status, 'timeout');
  assert.equal(view.currentStageIndex, null);
  assert.equal(view.deadline, null);
  s.close();
});

test('长时间未推进后直接查看：跨过 48 小时直接超时，不重新获得升级期限', () => {
  const s = svc();
  s.submitTicket({
    ticketId: 't',
    stages: [{ approvers: ['a', 'b'], escalatedApprovers: ['x'] }],
    now: T0,
  });
  s.submitDecision({
    ticketId: 't', stageIndex: 0, round: 'normal',
    approver: 'a', decisionId: 'd1', approve: true, now: T0 + 100,
  });
  // 从未调用 advanceTime，直接以 T0+48h 之后的时刻查看
  const view = s.getTicket('t', T0 + 2 * H + 5000);
  assert.equal(view.status, 'timeout');
  // 超时不可逆：之后的决定不予受理
  const r = s.submitDecision({
    ticketId: 't', stageIndex: 0, round: 'escalated',
    approver: 'x', decisionId: 'd2', approve: true, now: T0 + 2 * H + 6000,
  });
  assert.equal(r.conclusion, 'ticket-closed');
  s.close();
});

test('推进时间使所有未结束工单兑现到期转换', () => {
  const s = svc();
  s.submitTicket({
    ticketId: 't1',
    stages: [{ approvers: ['a'], escalatedApprovers: ['x'] }],
    now: T0,
  });
  s.submitTicket({
    ticketId: 't2',
    stages: [{ approvers: ['a'], escalatedApprovers: ['x'] }],
    now: T0 + H,
  });
  s.advanceTime(T0 + H + 1);
  assert.equal(s.getTicket('t1', T0 + H + 1).currentRound, 'escalated');
  const v2 = s.getTicket('t2', T0 + H + 1);
  assert.equal(v2.currentRound, 'normal');
  assert.equal(v2.deadline, T0 + 2 * H);
  s.close();
});

test('升级轮会签：升级组重新完成会签后通过', () => {
  const s = svc();
  s.submitTicket({
    ticketId: 't',
    stages: [{ approvers: ['a', 'b'], escalatedApprovers: ['x', 'y'] }],
    now: T0,
  });
  s.submitDecision({
    ticketId: 't', stageIndex: 0, round: 'normal',
    approver: 'a', decisionId: 'd1', approve: true, now: T0 + 1,
  });
  s.advanceTime(T0 + H);
  // 普通组成员在升级轮不是成员
  const outsider = s.submitDecision({
    ticketId: 't', stageIndex: 0, round: 'escalated',
    approver: 'b', decisionId: 'd2', approve: true, now: T0 + H + 1,
  });
  assert.equal(outsider.conclusion, 'not-approver');
  s.submitDecision({
    ticketId: 't', stageIndex: 0, round: 'escalated',
    approver: 'x', decisionId: 'd3', approve: true, now: T0 + H + 2,
  });
  const r = s.submitDecision({
    ticketId: 't', stageIndex: 0, round: 'escalated',
    approver: 'y', decisionId: 'd4', approve: true, now: T0 + H + 3,
  });
  assert.equal(r.ticketStatus, 'approved');
  s.close();
});
