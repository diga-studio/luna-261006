import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advanceTime, createTicket, getTicket, submitDecision } from '../src/index';
import { cleanup, freshDb, DAY, T0 } from './helpers';

/** 普通轮部分签署后恰好到期：切升级轮、同意清空、升级组重新会签；截止时刻的最后一票不能补齐 */
test('normal round expires exactly at deadline: approvals cleared, escalation must re-sign', () => {
  const { db, path } = freshDb();
  try {
    createTicket(
      db,
      { ticketId: 't1', stages: [{ approvers: ['a', 'b'], escalatedApprovers: ['b', 'e'] }] },
      T0,
    );
    // a 在普通轮同意
    let r = submitDecision(db, { ticketId: 't1', stageIndex: 0, round: 'normal', approver: 'a', decisionId: 'd-a', verdict: 'approve' }, T0 + 1000);
    assert.equal(r.conclusion, 'accepted');
    let view = getTicket(db, 't1', T0 + 1000)!;
    assert.deepEqual(view.approvals, ['a']);

    // b 在截止时刻（同一毫秒）投普通轮同意：先处理到期，该票不能补齐会签
    r = submitDecision(db, { ticketId: 't1', stageIndex: 0, round: 'normal', approver: 'b', decisionId: 'd-b', verdict: 'approve' }, T0 + DAY);
    assert.equal(r.conclusion, 'stale-round');

    view = getTicket(db, 't1', T0 + DAY)!;
    assert.equal(view.status, 'open');
    assert.equal(view.round, 'escalation');
    assert.deepEqual(view.approvals, []); // 普通轮同意被清空
    assert.equal(view.deadline, T0 + 2 * DAY); // 升级轮从原截止时刻起算 24h

    // 人员重叠的 b 用旧决定标识重投：返回首次结论（stale-round），不计票
    r = submitDecision(db, { ticketId: 't1', stageIndex: 0, round: 'escalation', approver: 'b', decisionId: 'd-b', verdict: 'approve' }, T0 + DAY + 1);
    assert.equal(r.conclusion, 'stale-round');
    view = getTicket(db, 't1', T0 + DAY + 1)!;
    assert.deepEqual(view.approvals, []);

    // a 已不在当前轮成员中
    r = submitDecision(db, { ticketId: 't1', stageIndex: 0, round: 'escalation', approver: 'a', decisionId: 'd-a2', verdict: 'approve' }, T0 + DAY + 2);
    assert.equal(r.conclusion, 'not-approver');

    // 升级组（含重叠成员 b）用新标识重新会签
    r = submitDecision(db, { ticketId: 't1', stageIndex: 0, round: 'escalation', approver: 'b', decisionId: 'd-b-esc', verdict: 'approve' }, T0 + DAY + 3);
    assert.equal(r.conclusion, 'accepted');
    r = submitDecision(db, { ticketId: 't1', stageIndex: 0, round: 'escalation', approver: 'e', decisionId: 'd-e-esc', verdict: 'approve' }, T0 + DAY + 4);
    assert.equal(r.conclusion, 'accepted');
    assert.equal(r.status, 'approved');
  } finally {
    db.close();
    cleanup(path);
  }
});

/** 旧决定不能跨阶段复用：上一阶段的签名在下一阶段重投不计票 */
test('decisions from a previous stage cannot be replayed into the next stage', () => {
  const { db, path } = freshDb();
  try {
    createTicket(
      db,
      {
        ticketId: 't2',
        stages: [
          { approvers: ['a'], escalatedApprovers: ['x'] },
          { approvers: ['a'], escalatedApprovers: ['y'] },
        ],
      },
      T0,
    );
    let r = submitDecision(db, { ticketId: 't2', stageIndex: 0, round: 'normal', approver: 'a', decisionId: 'sig-1', verdict: 'approve' }, T0 + 10);
    assert.equal(r.conclusion, 'accepted');
    let view = getTicket(db, 't2', T0 + 10)!;
    assert.equal(view.stageIndex, 1);

    // 同一签名（相同决定标识）投向新阶段：返回首次结论 accepted，但不计入新阶段
    r = submitDecision(db, { ticketId: 't2', stageIndex: 1, round: 'normal', approver: 'a', decisionId: 'sig-1', verdict: 'approve' }, T0 + 20);
    assert.equal(r.conclusion, 'accepted'); // 首次结论的重放
    view = getTicket(db, 't2', T0 + 20)!;
    assert.equal(view.status, 'open'); // 没有凑齐新会签
    assert.deepEqual(view.approvals, []);

    // 同一审批人须用新标识在新阶段重新投票
    r = submitDecision(db, { ticketId: 't2', stageIndex: 1, round: 'normal', approver: 'a', decisionId: 'sig-2', verdict: 'approve' }, T0 + 30);
    assert.equal(r.conclusion, 'accepted');
    assert.equal(r.status, 'approved');
  } finally {
    db.close();
    cleanup(path);
  }
});

/** 升级轮到期：整单超时；一次跨过 48h 直接超时，不重新获得升级期限 */
test('crossing both deadlines in one step expires the ticket directly', () => {
  const { db, path } = freshDb();
  try {
    createTicket(
      db,
      { ticketId: 't3', stages: [{ approvers: ['a'], escalatedApprovers: ['e'] }] },
      T0,
    );
    // 长时间未推进，直接查看：跨过 48h，立即超时
    const view = getTicket(db, 't3', T0 + 2 * DAY)!;
    assert.equal(view.status, 'expired');
    assert.equal(view.round, 'escalation'); // 停留在升级轮，而非新的 24h
    assert.equal(view.deadline, T0 + 2 * DAY);

    // 终态不可逆：之后的决定与查看都保持超时
    const r = submitDecision(db, { ticketId: 't3', stageIndex: 0, round: 'escalation', approver: 'e', decisionId: 'late', verdict: 'approve' }, T0 + 2 * DAY + 1);
    assert.equal(r.conclusion, 'ticket-closed');
    assert.equal(getTicket(db, 't3', T0 + 3 * DAY)!.status, 'expired');
  } finally {
    db.close();
    cleanup(path);
  }
});

/** 推进时间使所有未结束工单兑现到期转换；查看不依赖推进曾被调用 */
test('advanceTime applies expiry to all open tickets', () => {
  const { db, path } = freshDb();
  try {
    createTicket(db, { ticketId: 'ta', stages: [{ approvers: ['a'], escalatedApprovers: ['e'] }] }, T0);
    createTicket(db, { ticketId: 'tb', stages: [{ approvers: ['a'], escalatedApprovers: ['e'] }] }, T0);
    advanceTime(db, T0 + DAY); // 恰好到普通轮截止：两单都进升级轮
    assert.equal(getTicket(db, 'ta', T0 + DAY)!.round, 'escalation');
    assert.equal(getTicket(db, 'tb', T0 + DAY)!.round, 'escalation');
    advanceTime(db, T0 + 2 * DAY);
    assert.equal(getTicket(db, 'ta', T0 + 2 * DAY)!.status, 'expired');
    assert.equal(getTicket(db, 'tb', T0 + 2 * DAY)!.status, 'expired');
  } finally {
    db.close();
    cleanup(path);
  }
});
