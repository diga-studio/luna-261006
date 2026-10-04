import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApprovalService, ROUND_DURATION_MS } from '../src/index.js';

const T0 = 1_000_000_000_000;
const H = ROUND_DURATION_MS;

test('人员重叠：同一审批人可出现在普通组与升级组、相邻阶段', () => {
  const svc = new ApprovalService(':memory:');
  svc.submitTicket({
    ticketId: 't',
    stages: [
      { approvers: ['a', 'b'], escalatedApprovers: ['a', 'c'] },
      { approvers: ['a'], escalatedApprovers: ['a'] },
    ],
    now: T0,
  });
  // a 在阶段 0 普通轮投票
  svc.submitDecision({
    ticketId: 't', stageIndex: 0, round: 'normal',
    approver: 'a', decisionId: 'd1', approve: true, now: T0 + 1,
  });
  svc.submitDecision({
    ticketId: 't', stageIndex: 0, round: 'normal',
    approver: 'b', decisionId: 'd2', approve: true, now: T0 + 2,
  });
  // a 在阶段 1 普通轮是新的一票，不是改票
  const r = svc.submitDecision({
    ticketId: 't', stageIndex: 1, round: 'normal',
    approver: 'a', decisionId: 'd3', approve: true, now: T0 + 3,
  });
  assert.equal(r.conclusion, 'counted');
  assert.equal(r.ticketStatus, 'approved');
  svc.close();
});

test('旧轮迟到决定不能用于新轮，旧票凑不齐新会签', () => {
  const svc = new ApprovalService(':memory:');
  svc.submitTicket({
    ticketId: 't',
    stages: [{ approvers: ['a', 'b'], escalatedApprovers: ['x', 'y'] }],
    now: T0,
  });
  // 普通轮 a 同意后到期，切换升级轮
  svc.submitDecision({
    ticketId: 't', stageIndex: 0, round: 'normal',
    approver: 'a', decisionId: 'd1', approve: true, now: T0 + 1,
  });
  svc.advanceTime(T0 + H);

  // 普通轮旧决定（新标识）迟到：不予受理
  const lateNormal = svc.submitDecision({
    ticketId: 't', stageIndex: 0, round: 'normal',
    approver: 'b', decisionId: 'd2', approve: true, now: T0 + H + 1,
  });
  assert.equal(lateNormal.conclusion, 'stale-round');

  // 升级组 x 同意；普通轮 a 的旧票不能计入升级轮会签
  svc.submitDecision({
    ticketId: 't', stageIndex: 0, round: 'escalated',
    approver: 'x', decisionId: 'd3', approve: true, now: T0 + H + 2,
  });
  const view = svc.getTicket('t', T0 + H + 2);
  assert.equal(view.status, 'pending');
  assert.deepEqual(view.agreedApprovers, ['x']);

  // 升级组 y 同意后才会通过
  const r = svc.submitDecision({
    ticketId: 't', stageIndex: 0, round: 'escalated',
    approver: 'y', decisionId: 'd4', approve: true, now: T0 + H + 3,
  });
  assert.equal(r.ticketStatus, 'approved');
  svc.close();
});

test('同一人的签名不能跨阶段复用：下一阶段重投旧标识返回首次结论', () => {
  const svc = new ApprovalService(':memory:');
  svc.submitTicket({
    ticketId: 't',
    stages: [
      { approvers: ['a'], escalatedApprovers: ['x'] },
      { approvers: ['a'], escalatedApprovers: ['x'] },
    ],
    now: T0,
  });
  const first = svc.submitDecision({
    ticketId: 't', stageIndex: 0, round: 'normal',
    approver: 'a', decisionId: 'd1', approve: true, now: T0 + 1,
  });
  assert.equal(first.ticketStatus, 'pending');
  // 工单进入阶段 1；用同一决定标识向阶段 1 重投
  const replay = svc.submitDecision({
    ticketId: 't', stageIndex: 1, round: 'normal',
    approver: 'a', decisionId: 'd1', approve: true, now: T0 + 2,
  });
  // 返回首次受理结论，不再次计票
  assert.equal(replay.conclusion, first.conclusion);
  assert.equal(replay.duplicate, true);
  const view = svc.getTicket('t', T0 + 2);
  assert.equal(view.currentStageIndex, 1);
  assert.deepEqual(view.agreedApprovers, []);
  svc.close();
});

test('重新打开数据库后：状态与去重结论保持不变', () => {
  const dir = mkdtempSync(join(tmpdir(), 'approval-'));
  const dbPath = join(dir, 'state.db');
  try {
    let svc = new ApprovalService(dbPath);
    svc.submitTicket({
      ticketId: 't',
      stages: [
        { approvers: ['a', 'b'], escalatedApprovers: ['x'] },
        { approvers: ['c'], escalatedApprovers: ['y'] },
      ],
      now: T0,
    });
    const first = svc.submitDecision({
      ticketId: 't', stageIndex: 0, round: 'normal',
      approver: 'a', decisionId: 'd1', approve: true, now: T0 + 1,
    });
    // 该决定推动不了阶段切换，再补一票推动切换
    const switchVote = svc.submitDecision({
      ticketId: 't', stageIndex: 0, round: 'normal',
      approver: 'b', decisionId: 'd2', approve: true, now: T0 + 2,
    });
    assert.equal(switchVote.ticketStatus, 'pending');
    svc.close();

    // 重新打开：状态保持
    svc = new ApprovalService(dbPath);
    const view = svc.getTicket('t', T0 + 2);
    assert.equal(view.status, 'pending');
    assert.equal(view.currentStageIndex, 1);
    assert.equal(view.currentRound, 'normal');
    assert.equal(view.deadline, T0 + 2 + H);

    // 重投推动过阶段切换的决定：仍返回首次结论，不重复计票
    const replaySwitch = svc.submitDecision({
      ticketId: 't', stageIndex: 0, round: 'normal',
      approver: 'b', decisionId: 'd2', approve: true, now: T0 + 3,
    });
    assert.equal(replaySwitch.conclusion, 'counted');
    assert.equal(replaySwitch.duplicate, true);
    const replayFirst = svc.submitDecision({
      ticketId: 't', stageIndex: 0, round: 'normal',
      approver: 'a', decisionId: 'd1', approve: true, now: T0 + 4,
    });
    assert.equal(replayFirst.conclusion, first.conclusion);
    assert.equal(replayFirst.duplicate, true);

    // 阶段 1 仍未被旧票影响
    const view2 = svc.getTicket('t', T0 + 4);
    assert.equal(view2.currentStageIndex, 1);
    assert.deepEqual(view2.agreedApprovers, []);

    // 新决定正常推进到批准
    const final = svc.submitDecision({
      ticketId: 't', stageIndex: 1, round: 'normal',
      approver: 'c', decisionId: 'd3', approve: true, now: T0 + 5,
    });
    assert.equal(final.ticketStatus, 'approved');
    svc.close();

    // 再次打开：终态与重投结论依旧保持
    svc = new ApprovalService(dbPath);
    assert.equal(svc.getTicket('t', T0 + 5).status, 'approved');
    const replayFinal = svc.submitDecision({
      ticketId: 't', stageIndex: 1, round: 'normal',
      approver: 'c', decisionId: 'd3', approve: true, now: T0 + 6,
    });
    assert.equal(replayFinal.conclusion, 'counted');
    assert.equal(replayFinal.duplicate, true);
    svc.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
