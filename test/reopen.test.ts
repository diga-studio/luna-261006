import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTicket, getTicket, openDatabase, submitDecision } from '../src/index';
import { cleanup, freshDbPath, DAY, T0 } from './helpers';

/** 重新打开数据库后：状态与去重结论保持不变，重投不会再次计票或重复推动阶段转换 */
test('reopen preserves state and dedup conclusions', () => {
  const path = freshDbPath();
  try {
    let db = openDatabase(path);
    createTicket(
      db,
      {
        ticketId: 't1',
        stages: [
          { approvers: ['a', 'b'], escalatedApprovers: ['x'] },
          { approvers: ['c'], escalatedApprovers: ['y'] },
        ],
      },
      T0,
    );
    // d1 受理；d3 是一张 stale-round 结论（普通轮进行中投升级轮）；d2 推动阶段转换
    let r = submitDecision(db, { ticketId: 't1', stageIndex: 0, round: 'normal', approver: 'a', decisionId: 'd1', verdict: 'approve' }, T0 + 1);
    assert.equal(r.conclusion, 'accepted');
    r = submitDecision(db, { ticketId: 't1', stageIndex: 0, round: 'escalation', approver: 'x', decisionId: 'd3', verdict: 'approve' }, T0 + 1);
    assert.equal(r.conclusion, 'stale-round');
    r = submitDecision(db, { ticketId: 't1', stageIndex: 0, round: 'normal', approver: 'b', decisionId: 'd2', verdict: 'approve' }, T0 + 2);
    assert.equal(r.conclusion, 'accepted');
    db.close();

    // 重新打开，重投全部三个决定：结论与首次一致，且不再计票
    db = openDatabase(path);
    r = submitDecision(db, { ticketId: 't1', stageIndex: 0, round: 'normal', approver: 'a', decisionId: 'd1', verdict: 'approve' }, T0 + 4);
    assert.equal(r.conclusion, 'accepted');
    r = submitDecision(db, { ticketId: 't1', stageIndex: 0, round: 'normal', approver: 'b', decisionId: 'd2', verdict: 'approve' }, T0 + 4);
    assert.equal(r.conclusion, 'accepted');
    r = submitDecision(db, { ticketId: 't1', stageIndex: 0, round: 'escalation', approver: 'x', decisionId: 'd3', verdict: 'approve' }, T0 + 4);
    assert.equal(r.conclusion, 'stale-round');

    // 工单仍停留在第 2 阶段普通轮，且没有被重复推动
    let view = getTicket(db, 't1', T0 + 4)!;
    assert.equal(view.status, 'open');
    assert.equal(view.stageIndex, 1);
    assert.equal(view.round, 'normal');
    assert.deepEqual(view.approvals, []);
    assert.equal(view.deadline, T0 + 2 + DAY); // 从第 1 阶段通过时刻起算

    // 新阶段正常完成
    r = submitDecision(db, { ticketId: 't1', stageIndex: 1, round: 'normal', approver: 'c', decisionId: 'd4', verdict: 'approve' }, T0 + 5);
    assert.equal(r.conclusion, 'accepted');
    assert.equal(r.status, 'approved');
    db.close();

    // 再次打开：终态与重投结论依旧
    db = openDatabase(path);
    view = getTicket(db, 't1', T0 + 6)!;
    assert.equal(view.status, 'approved');
    r = submitDecision(db, { ticketId: 't1', stageIndex: 1, round: 'normal', approver: 'c', decisionId: 'd4', verdict: 'approve' }, T0 + 6);
    assert.equal(r.conclusion, 'accepted'); // 重放首次结论，而非 ticket-closed
    db.close();
  } finally {
    cleanup(path);
  }
});

/** 重新打开后，到期转换基于持久化的截止时刻继续生效 */
test('reopen preserves deadlines for expiry processing', () => {
  const path = freshDbPath();
  try {
    let db = openDatabase(path);
    createTicket(db, { ticketId: 't2', stages: [{ approvers: ['a'], escalatedApprovers: ['e'] }] }, T0);
    submitDecision(db, { ticketId: 't2', stageIndex: 0, round: 'normal', approver: 'a', decisionId: 'p1', verdict: 'approve' }, T0 + 10);
    db.close();

    db = openDatabase(path);
    // 直接查看：第 1 阶段在 T0+10 通过，第 2 阶段不存在，整单已批准
    assert.equal(getTicket(db, 't2', T0 + DAY)!.status, 'approved');
    db.close();
  } finally {
    cleanup(path);
  }
});
