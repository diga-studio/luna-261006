import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTicket,
  getTicket,
  submitDecision,
  DecisionInput,
  DecisionResult,
} from '../src/index';
import { cleanup, freshDb, DAY, T0 } from './helpers';

function runConcurrent(db: any, calls: DecisionInput[], now: number): Promise<DecisionResult[]> {
  return Promise.all(calls.map((d) => Promise.resolve().then(() => submitDecision(db, d, now))));
}

/** 并发提交：最后几张同意票 + 一张驳回票 + 大量重复提交，结果须等价于某个合法串行顺序 */
test('concurrent final approvals, a reject and duplicate submissions resolve to a legal serial order', async () => {
  const { db, path } = freshDb();
  try {
    createTicket(
      db,
      {
        ticketId: 't1',
        stages: [
          { approvers: ['a', 'b', 'c'], escalatedApprovers: ['x'] },
          { approvers: ['a', 'b'], escalatedApprovers: ['y'] },
        ],
      },
      T0,
    );

    const unique: DecisionInput[] = [
      { ticketId: 't1', stageIndex: 0, round: 'normal', approver: 'a', decisionId: 'd-a', verdict: 'approve' },
      { ticketId: 't1', stageIndex: 0, round: 'normal', approver: 'b', decisionId: 'd-b', verdict: 'approve' },
      { ticketId: 't1', stageIndex: 0, round: 'normal', approver: 'c', decisionId: 'd-c', verdict: 'approve' },
      { ticketId: 't1', stageIndex: 0, round: 'normal', approver: 'c', decisionId: 'd-r', verdict: 'reject' },
    ];
    // 每个唯一决定重复 25 次，共 100 个并发调用
    const calls: DecisionInput[] = [];
    for (let i = 0; i < 25; i++) calls.push(...unique.map((d) => ({ ...d })));

    const results = await runConcurrent(db, calls, T0 + 1000);

    // 同一 decisionId 的所有返回必须一致（重投放回首次结论）
    for (const d of unique) {
      const rs = results.filter((_, i) => calls[i].decisionId === d.decisionId);
      assert.equal(rs.length, 25);
      for (const r of rs) assert.equal(r.conclusion, rs[0].conclusion, `decision ${d.decisionId}`);
    }

    const conclusionOf = (id: string) => results[calls.findIndex((c) => c.decisionId === id)].conclusion;
    const view = getTicket(db, 't1', T0 + 1000)!;

    if (conclusionOf('d-r') === 'accepted') {
      // 驳回在会签完成前被受理：整单驳回
      assert.equal(view.status, 'rejected');
      assert.equal(view.stageIndex, 0);
      assert.equal(view.round, 'normal');
    } else {
      // 驳回被序列化到 c 投同意之后：already-voted；若已在下一阶段：stale-stage
      assert.ok(['already-voted', 'stale-stage'].includes(conclusionOf('d-r')));
      assert.equal(conclusionOf('d-a'), 'accepted');
      assert.equal(conclusionOf('d-b'), 'accepted');
      assert.equal(conclusionOf('d-c'), 'accepted');
      // 会签只推动一次阶段转换：进入第 2 阶段普通轮，旧轮同意不带入新阶段
      assert.equal(view.status, 'open');
      assert.equal(view.stageIndex, 1);
      assert.equal(view.round, 'normal');
      assert.deepEqual(view.approvals, []);
      assert.equal(view.deadline, T0 + 1000 + DAY);
    }
  } finally {
    db.close();
    cleanup(path);
  }
});

/** 并发下同一审批人同一轮只有首次决定生效，改票无效（同意先到的情形） */
test('concurrent conflicting votes by same approver: first vote wins (approve first)', async () => {
  const { db, path } = freshDb();
  try {
    createTicket(
      db,
      { ticketId: 't2', stages: [{ approvers: ['a', 'b'], escalatedApprovers: ['x'] }] },
      T0,
    );
    const calls: DecisionInput[] = [];
    for (let i = 0; i < 33; i++) {
      calls.push({ ticketId: 't2', stageIndex: 0, round: 'normal', approver: 'a', decisionId: 'a-ok', verdict: 'approve' });
      calls.push({ ticketId: 't2', stageIndex: 0, round: 'normal', approver: 'a', decisionId: `a-no-${i}`, verdict: 'reject' });
      calls.push({ ticketId: 't2', stageIndex: 0, round: 'normal', approver: 'b', decisionId: 'b-ok', verdict: 'approve' });
    }
    const results = await runConcurrent(db, calls, T0 + 5);

    const conclusionOf = (id: string) => results[calls.findIndex((c) => c.decisionId === id)].conclusion;
    assert.equal(conclusionOf('a-ok'), 'accepted');
    assert.equal(conclusionOf('b-ok'), 'accepted');
    // a-no-0 序列化在会签完成前：a 已投过 -> already-voted；之后的在终态后 -> ticket-closed
    assert.equal(conclusionOf('a-no-0'), 'already-voted');
    for (let i = 1; i < 33; i++) assert.equal(conclusionOf(`a-no-${i}`), 'ticket-closed');

    const view = getTicket(db, 't2', T0 + 5)!;
    assert.equal(view.status, 'approved');
  } finally {
    db.close();
    cleanup(path);
  }
});

/** 并发下同一审批人同一轮只有首次决定生效（驳回先到的情形） */
test('concurrent conflicting votes by same approver: first vote wins (reject first)', async () => {
  const { db, path } = freshDb();
  try {
    createTicket(
      db,
      { ticketId: 't3', stages: [{ approvers: ['a', 'b'], escalatedApprovers: ['x'] }] },
      T0,
    );
    const calls: DecisionInput[] = [];
    for (let i = 0; i < 33; i++) {
      calls.push({ ticketId: 't3', stageIndex: 0, round: 'normal', approver: 'a', decisionId: 'a-no', verdict: 'reject' });
      calls.push({ ticketId: 't3', stageIndex: 0, round: 'normal', approver: 'a', decisionId: `a-ok-${i}`, verdict: 'approve' });
      calls.push({ ticketId: 't3', stageIndex: 0, round: 'normal', approver: 'b', decisionId: 'b-ok', verdict: 'approve' });
    }
    const results = await runConcurrent(db, calls, T0 + 5);

    const conclusionOf = (id: string) => results[calls.findIndex((c) => c.decisionId === id)].conclusion;
    assert.equal(conclusionOf('a-no'), 'accepted');
    // 驳回即终态，之后的同意全部是 ticket-closed
    for (let i = 0; i < 33; i++) assert.equal(conclusionOf(`a-ok-${i}`), 'ticket-closed');
    assert.equal(conclusionOf('b-ok'), 'ticket-closed');

    const view = getTicket(db, 't3', T0 + 5)!;
    assert.equal(view.status, 'rejected');
  } finally {
    db.close();
    cleanup(path);
  }
});
