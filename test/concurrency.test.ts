import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalService } from '../src/index.js';
import type { DecisionResult, SubmitDecisionInput } from '../src/index.js';

const T0 = 1_000_000_000_000;

/** 让所有调用在同一微任务栅栏后并发触发。 */
async function race<T>(fns: Array<() => T>): Promise<T[]> {
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = fns.map((fn) => barrier.then(() => fn()));
  release();
  return Promise.all(pending);
}

function decision(partial: Partial<SubmitDecisionInput>): SubmitDecisionInput {
  return {
    ticketId: 't',
    stageIndex: 0,
    round: 'normal',
    approver: 'a',
    decisionId: 'd',
    approve: true,
    now: T0 + 1,
    ...partial,
  };
}

test('100 并发：最后几张同意票与驳回票竞争，结果符合某个合法串行顺序', async () => {
  const svc = new ApprovalService(':memory:');
  const approvers = Array.from({ length: 5 }, (_, i) => `a${i}`);
  svc.submitTicket({
    ticketId: 't',
    stages: [{ approvers, escalatedApprovers: ['x'] }],
    now: T0,
  });

  const calls: Array<() => DecisionResult> = [];
  // 前 4 人同意，第 5 人的同意票与一张驳回票竞争“最后一票”
  for (let i = 0; i < 4; i += 1) {
    calls.push(() => svc.submitDecision(decision({ approver: `a${i}`, decisionId: `ok${i}` })));
  }
  for (let k = 0; k < 48; k += 1) {
    calls.push(() => svc.submitDecision(decision({ approver: 'a4', decisionId: 'last-approve' })));
    calls.push(() => svc.submitDecision(decision({ approver: 'a4', decisionId: 'last-reject', approve: false })));
  }

  const results = await race(calls);
  const final = svc.getTicket('t', T0 + 2);

  const firstApprove = results.find((r) => r.decisionId === 'last-approve' && !r.duplicate);
  const firstReject = results.find((r) => r.decisionId === 'last-reject' && !r.duplicate);
  assert.ok(firstApprove && firstReject);

  // 合法串行顺序只有两种结局：同意先凑齐则批准，驳回先生效则驳回
  if (firstApprove.conclusion === 'counted' && firstApprove.ticketStatus === 'approved') {
    assert.equal(final.status, 'approved');
    assert.equal(firstReject.conclusion, 'ticket-closed');
  } else {
    assert.equal(firstReject.conclusion, 'counted');
    assert.equal(firstReject.ticketStatus, 'rejected');
    assert.equal(final.status, 'rejected');
    assert.ok(
      firstApprove.conclusion === 'ticket-closed',
      `unexpected: ${firstApprove.conclusion}`,
    );
  }

  // 重投必须返回首次结论
  for (const r of results) {
    if (!r.duplicate) continue;
    const first: DecisionResult = r.decisionId === 'last-approve' ? firstApprove : firstReject;
    assert.equal(r.conclusion, first.conclusion);
    assert.equal(r.ticketStatus, first.ticketStatus);
  }
  svc.close();
});

test('100 并发重投同一决定标识：恰好计票一次', async () => {
  const svc = new ApprovalService(':memory:');
  svc.submitTicket({
    ticketId: 't',
    stages: [{ approvers: ['a', 'b'], escalatedApprovers: ['x'] }],
    now: T0,
  });
  const results = await race(
    Array.from({ length: 100 }, () => () =>
      svc.submitDecision(decision({ approver: 'a', decisionId: 'same' })),
    ),
  );
  const counted = results.filter((r) => !r.duplicate);
  assert.equal(counted.length, 1);
  assert.equal(counted[0].conclusion, 'counted');
  for (const r of results) {
    assert.equal(r.conclusion, 'counted');
  }
  const view = svc.getTicket('t', T0 + 1);
  assert.deepEqual(view.agreedApprovers, ['a']);
  svc.close();
});

test('决定、查看与推进时间并发：任何一次会签完成只推动一次阶段转换', async () => {
  const svc = new ApprovalService(':memory:');
  svc.submitTicket({
    ticketId: 't',
    stages: [
      { approvers: ['a', 'b'], escalatedApprovers: ['x'] },
      { approvers: ['c', 'd'], escalatedApprovers: ['y'] },
    ],
    now: T0,
  });
  const calls: Array<() => unknown> = [];
  for (let i = 0; i < 30; i += 1) {
    calls.push(() => svc.submitDecision(decision({ approver: 'a', decisionId: 'da' })));
    calls.push(() => svc.submitDecision(decision({ approver: 'b', decisionId: 'db' })));
    calls.push(() => svc.getTicket('t', T0 + 1));
    calls.push(() => svc.advanceTime(T0 + 1));
  }
  calls.push(() => svc.submitDecision(decision({ approver: 'c', decisionId: 'dc', stageIndex: 1 })));
  await race(calls);

  const view = svc.getTicket('t', T0 + 1);
  // 阶段 0 只会通过一次：之后阶段 0 的决定只能是 stale-round / already-voted / duplicate
  assert.equal(view.currentStageIndex, 1);
  assert.equal(view.currentRound, 'normal');
  assert.equal(view.deadline, T0 + 1 + 24 * 60 * 60 * 1000);
  svc.close();
});
