import { DatabaseSync } from 'node:sqlite';
import { inTransaction, ROUND_MS } from './db';
import { applyExpiry } from './expiry';
import { CreateTicketInput, StageSpec, TicketView } from './types';

interface TicketRow {
  status: string;
  stage_index: number;
  round: string;
  deadline: number;
  stages_json: string;
}

function normalizeStages(stages: StageSpec[]): StageSpec[] {
  if (!Array.isArray(stages) || stages.length < 1 || stages.length > 5) {
    throw new Error('stages must contain 1 to 5 stages');
  }
  return stages.map((s) => {
    const approvers = [...new Set(s.approvers)];
    const escalatedApprovers = [...new Set(s.escalatedApprovers)];
    if (approvers.length === 0) throw new Error('stage approvers must be non-empty');
    if (escalatedApprovers.length === 0) throw new Error('stage escalatedApprovers must be non-empty');
    return { approvers, escalatedApprovers };
  });
}

/** 提交工单；首阶段普通轮从 now 开始计时 */
export function createTicket(db: DatabaseSync, input: CreateTicketInput, now: number): void {
  const stages = normalizeStages(input.stages);
  inTransaction(db, () => {
    const exists = db.prepare('SELECT 1 FROM tickets WHERE ticket_id = ?').get(input.ticketId);
    if (exists) throw new Error(`ticket already exists: ${input.ticketId}`);
    db.prepare(
      'INSERT INTO tickets (ticket_id, status, stage_index, round, deadline, stages_json) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(input.ticketId, 'open', 0, 'normal', now + ROUND_MS, JSON.stringify(stages));
  });
}

/** 查看工单；先落实截至 now 的到期转换，再读取当前阶段/轮次的快照 */
export function getTicket(db: DatabaseSync, ticketId: string, now: number): TicketView | null {
  return inTransaction(db, () => {
    applyExpiry(db, ticketId, now);
    const row = db
      .prepare('SELECT status, stage_index, round, deadline, stages_json FROM tickets WHERE ticket_id = ?')
      .get(ticketId) as TicketRow | undefined;
    if (!row) return null;
    const approvals = (
      db
        .prepare(
          "SELECT approver FROM votes WHERE ticket_id = ? AND stage_index = ? AND round = ? AND verdict = 'approve' ORDER BY approver",
        )
        .all(ticketId, Number(row.stage_index), row.round) as Array<{ approver: string }>
    ).map((r) => r.approver);
    return {
      ticketId,
      status: row.status as TicketView['status'],
      stageIndex: Number(row.stage_index),
      round: row.round as TicketView['round'],
      approvals,
      deadline: Number(row.deadline),
    };
  });
}
