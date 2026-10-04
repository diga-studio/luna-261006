import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalService, ROUND_DURATION_MS } from '../src/index.js';

const T0 = 1_000_000_000_000;

function makeService(): ApprovalService {
  return new ApprovalService(':memory:');
}

test('单阶段会签通过后整单批准', () => {
  const svc = makeService();
  svc.submitTicket({
    ticketId: 't1',
    stages: [{ approvers: ['a', 'b'], escalatedApprovers: ['x'] }],
    now: T0,
  });

  const view0 = svc.getTicket('t1', T0);
  assert.equal(view0.status, 'pending');
  assert.equal(view0.currentStageIndex, 0);
  assert.equal(view0.currentRound, 'normal');
  assert.deepEqual(view0.agreedApprovers, []);
  assert.equal(view0.deadline, T0 + ROUND_DURATION_MS);

  const r1 = svc.submitDecision({
    ticketId: 't1', stageIndex: 0, round: 'normal',
    approver: 'a', decisionId: 'd1', approve: true, now: T0 + 1000,
  });
  assert.equal(r1.conclusion, 'counted');
  assert.equal(r1.duplicate, false);
  assert.equal(r1.ticketStatus, 'pending');

  const view1 = svc.getTicket('t1', T0 + 1000);
  assert.deepEqual(view1.agreedApprovers, ['a']);

  const r2 = svc.submitDecision({
    ticketId: 't1', stageIndex: 0, round: 'normal',
    approver: 'b', decisionId: 'd2', approve: true, now: T0 + 2000,
  });
  assert.equal(r2.conclusion, 'counted');
  assert.equal(r2.ticketStatus, 'approved');

  const view2 = svc.getTicket('t1', T0 + 2000);
  assert.equal(view2.status, 'approved');
  assert.equal(view2.currentStageIndex, null);
  assert.equal(view2.currentRound, null);
  assert.deepEqual(view2.agreedApprovers, []);
  assert.equal(view2.deadline, null);
  svc.close();
});

test('多阶段顺序推进，通过后立即进入下一阶段普通轮', () => {
  const svc = makeService();
  svc.submitTicket({
    ticketId: 't2',
    stages: [
      { approvers: ['a'], escalatedApprovers: ['x'] },
      { approvers: ['b', 'c'], escalatedApprovers: ['y'] },
    ],
    now: T0,
  });
  svc.submitDecision({
    ticketId: 't2', stageIndex: 0, round: 'normal',
    approver: 'a', decisionId: 'd1', approve: true, now: T0 + 5000,
  });
  const view = svc.getTicket('t2', T0 + 5000);
  assert.equal(view.currentStageIndex, 1);
  assert.equal(view.currentRound, 'normal');
  // 下一阶段从上一阶段通过时刻开始计时
  assert.equal(view.deadline, T0 + 5000 + ROUND_DURATION_MS);
  // 不混合上一阶段的已同意人员
  assert.deepEqual(view.agreedApprovers, []);

  svc.submitDecision({
    ticketId: 't2', stageIndex: 1, round: 'normal',
    approver: 'b', decisionId: 'd2', approve: true, now: T0 + 6000,
  });
  const r = svc.submitDecision({
    ticketId: 't2', stageIndex: 1, round: 'normal',
    approver: 'c', decisionId: 'd3', approve: true, now: T0 + 7000,
  });
  assert.equal(r.ticketStatus, 'approved');
  svc.close();
});

test('任一有效驳回使整单驳回，且终态不可逆', () => {
  const svc = makeService();
  svc.submitTicket({
    ticketId: 't3',
    stages: [{ approvers: ['a', 'b'], escalatedApprovers: ['x'] }],
    now: T0,
  });
  svc.submitDecision({
    ticketId: 't3', stageIndex: 0, round: 'normal',
    approver: 'a', decisionId: 'd1', approve: true, now: T0 + 1,
  });
  const r = svc.submitDecision({
    ticketId: 't3', stageIndex: 0, round: 'normal',
    approver: 'b', decisionId: 'd2', approve: false, now: T0 + 2,
  });
  assert.equal(r.conclusion, 'counted');
  assert.equal(r.ticketStatus, 'rejected');

  // 终态后的新决定不予受理
  const late = svc.submitDecision({
    ticketId: 't3', stageIndex: 0, round: 'normal',
    approver: 'a', decisionId: 'd3', approve: true, now: T0 + 3,
  });
  assert.equal(late.conclusion, 'ticket-closed');
  assert.equal(svc.getTicket('t3', T0 + 3).status, 'rejected');
  svc.close();
});

test('非当前轮成员与重复投票不予受理', () => {
  const svc = makeService();
  svc.submitTicket({
    ticketId: 't4',
    stages: [{ approvers: ['a'], escalatedApprovers: ['x'] }],
    now: T0,
  });
  const stranger = svc.submitDecision({
    ticketId: 't4', stageIndex: 0, round: 'normal',
    approver: 'z', decisionId: 'd1', approve: true, now: T0 + 1,
  });
  assert.equal(stranger.conclusion, 'not-approver');

  svc.submitDecision({
    ticketId: 't4', stageIndex: 0, round: 'normal',
    approver: 'a', decisionId: 'd2', approve: true, now: T0 + 2,
  });
  // 工单已批准；用未关闭场景再验证 already-voted
  svc.submitTicket({
    ticketId: 't5',
    stages: [{ approvers: ['a', 'b'], escalatedApprovers: ['x'] }],
    now: T0,
  });
  svc.submitDecision({
    ticketId: 't5', stageIndex: 0, round: 'normal',
    approver: 'a', decisionId: 'd3', approve: true, now: T0 + 1,
  });
  const revote = svc.submitDecision({
    ticketId: 't5', stageIndex: 0, round: 'normal',
    approver: 'a', decisionId: 'd4', approve: false, now: T0 + 2,
  });
  assert.equal(revote.conclusion, 'already-voted');
  assert.equal(svc.getTicket('t5', T0 + 2).status, 'pending');
  svc.close();
});

test('非法阶段定义被拒绝', () => {
  const svc = makeService();
  assert.throws(() =>
    svc.submitTicket({ ticketId: 'bad', stages: [], now: T0 }),
  );
  assert.throws(() =>
    svc.submitTicket({
      ticketId: 'bad2',
      stages: [{ approvers: [], escalatedApprovers: ['x'] }],
      now: T0,
    }),
  );
  svc.close();
});
