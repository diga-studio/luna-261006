import { DatabaseSync } from 'node:sqlite';
import { inTransaction, ROUND_MS } from './db';
import { applyExpiry } from './expiry';
import { DecisionConclusion, DecisionInput, DecisionResult, StageSpec, TicketStatus } from './types';

interface TicketRow {
  status: string;
  stage_index: number;
  round: string;
  deadline: number;
  stages_json: string;
}

/**
 * 提交审批决定。
 * 先落实截至 now 的到期转换，再判定受理结论；结论、计票与阶段转换在同一事务生效。
 * 相同 decisionId 的重投直接返回首次持久化的结论，不再计票。
 */
export function submitDecision(db: DatabaseSync, input: DecisionInput, now: number): DecisionResult {
  return inTransaction(db, () => {
    applyExpiry(db, input.ticketId, now);

    const prior = db
      .prepare('SELECT conclusion FROM decisions WHERE ticket_id = ? AND decision_id = ?')
      .get(input.ticketId, input.decisionId) as { conclusion: string } | undefined;
    if (prior) {
      const status = currentStatus(db, input.ticketId);
      return { conclusion: prior.conclusion as DecisionConclusion, status };
    }

    const row = db
      .prepare('SELECT status, stage_index, round, deadline, stages_json FROM tickets WHERE ticket_id = ?')
      .get(input.ticketId) as TicketRow | undefined;
    if (!row) throw new Error(`ticket not found: ${input.ticketId}`);

    let status = row.status as TicketStatus;
    let stageIndex = Number(row.stage_index);
    let round = row.round;
    let deadline = Number(row.deadline);
    const stages = JSON.parse(row.stages_json) as StageSpec[];

    let conclusion: DecisionConclusion;
    if (status !== 'open') {
      conclusion = 'ticket-closed';
    } else if (input.stageIndex !== stageIndex) {
      conclusion = 'stale-stage';
    } else if (input.round !== round) {
      conclusion = 'stale-round';
    } else {
      const members = round === 'normal' ? stages[stageIndex].approvers : stages[stageIndex].escalatedApprovers;
      if (!members.includes(input.approver)) {
        conclusion = 'not-approver';
      } else {
        const voted = db
          .prepare('SELECT 1 FROM votes WHERE ticket_id = ? AND stage_index = ? AND round = ? AND approver = ?')
          .get(input.ticketId, stageIndex, round, input.approver);
        if (voted) {
          conclusion = 'already-voted';
        } else {
          conclusion = 'accepted';
          db.prepare(
            'INSERT INTO votes (ticket_id, stage_index, round, approver, decision_id, verdict) VALUES (?, ?, ?, ?, ?, ?)',
          ).run(input.ticketId, stageIndex, round, input.approver, input.decisionId, input.verdict);

          if (input.verdict === 'reject') {
            status = 'rejected';
          } else {
            const approvalCount = Number(
              (
                db
                  .prepare(
                    "SELECT COUNT(*) AS c FROM votes WHERE ticket_id = ? AND stage_index = ? AND round = ? AND verdict = 'approve'",
                  )
                  .get(input.ticketId, stageIndex, round) as { c: number }
              ).c,
            );
            if (approvalCount === members.length) {
              if (stageIndex === stages.length - 1) {
                status = 'approved';
              } else {
                stageIndex += 1;
                round = 'normal';
                deadline = now + ROUND_MS;
              }
            }
          }
        }
      }
    }

    db.prepare('UPDATE tickets SET status = ?, stage_index = ?, round = ?, deadline = ? WHERE ticket_id = ?').run(
      status,
      stageIndex,
      round,
      deadline,
      input.ticketId,
    );
    db.prepare('INSERT INTO decisions (ticket_id, decision_id, conclusion) VALUES (?, ?, ?)').run(
      input.ticketId,
      input.decisionId,
      conclusion,
    );
    return { conclusion, status };
  });
}

function currentStatus(db: DatabaseSync, ticketId: string): TicketStatus {
  const row = db.prepare('SELECT status FROM tickets WHERE ticket_id = ?').get(ticketId) as
    | { status: string }
    | undefined;
  if (!row) throw new Error(`ticket not found: ${ticketId}`);
  return row.status as TicketStatus;
}
