import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_SQL } from './schema.js';
import { ROUND_DURATION_MS } from './types.js';
import type {
  DecisionConclusion,
  DecisionResult,
  RoundKind,
  SubmitDecisionInput,
  SubmitTicketInput,
  TicketStatus,
  TicketView,
} from './types.js';

interface TicketRow {
  ticket_id: string;
  status: TicketStatus;
  current_stage_index: number | null;
  current_round: RoundKind | null;
  round_started_at: number | null;
  round_deadline: number | null;
  created_at: number;
}

interface StageRow {
  approvers: string;
  escalated_approvers: string;
}

/**
 * 审批裁决服务。由上层调用，状态保存在 SQLite。
 * 所有公共方法均为同步实现，且每次调用在单个事务内完成
 * 受理结论、计票与阶段转换；同一进程内的并发调用在事件
 * 循环上天然串行，等价于某个逐项执行顺序。
 */
export class ApprovalService {
  private readonly db: DatabaseSync;

  /** dbPath 为 SQLite 文件路径；传 ':memory:' 使用内存库。 */
  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(SCHEMA_SQL);
  }

  /** 关闭数据库连接。 */
  close(): void {
    this.db.close();
  }

  /** 提交工单：首阶段普通轮从 now 开始计时。 */
  submitTicket(input: SubmitTicketInput): void {
    const { ticketId, stages, now } = input;
    if (stages.length < 1 || stages.length > 5) {
      throw new Error('stages must contain 1 to 5 stages');
    }
    for (const stage of stages) {
      if (stage.approvers.length === 0 || stage.escalatedApprovers.length === 0) {
        throw new Error('each stage needs non-empty approver sets');
      }
    }
    this.inTransaction(() => {
      const existing = this.db
        .prepare('SELECT ticket_id FROM tickets WHERE ticket_id = ?')
        .get(ticketId);
      if (existing) {
        throw new Error(`ticket already exists: ${ticketId}`);
      }
      this.db
        .prepare(
          `INSERT INTO tickets
             (ticket_id, status, current_stage_index, current_round,
              round_started_at, round_deadline, created_at)
           VALUES (?, 'pending', 0, 'normal', ?, ?, ?)`,
        )
        .run(ticketId, now, now + ROUND_DURATION_MS, now);
      const insertStage = this.db.prepare(
        `INSERT INTO stages (ticket_id, stage_index, approvers, escalated_approvers)
         VALUES (?, ?, ?, ?)`,
      );
      stages.forEach((stage, index) => {
        insertStage.run(
          ticketId,
          index,
          JSON.stringify(stage.approvers),
          JSON.stringify(stage.escalatedApprovers),
        );
      });
    });
  }

  /**
   * 提交审批决定。先落实截至 now 的到期转换，再受理决定；
   * 相同决定标识的重投返回首次受理结论，不再次计票。
   */
  submitDecision(input: SubmitDecisionInput): DecisionResult {
    const { ticketId, stageIndex, round, approver, decisionId, approve, now } = input;
    return this.inTransaction(() => {
      const ticket = this.mustLoadTicket(ticketId);
      this.applyExpirations(ticket, now);

      const prior = this.db
        .prepare('SELECT conclusion FROM decisions WHERE ticket_id = ? AND decision_id = ?')
        .get(ticketId, decisionId) as { conclusion: DecisionConclusion } | undefined;
      if (prior) {
        return {
          decisionId,
          conclusion: prior.conclusion,
          duplicate: true,
          ticketStatus: ticket.status,
        };
      }

      const conclusion = this.adjudicate(ticket, input);
      this.db
        .prepare(
          `INSERT INTO decisions
             (ticket_id, decision_id, stage_index, round, approver,
              approve, conclusion, recorded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(ticketId, decisionId, stageIndex, round, approver, approve ? 1 : 0, conclusion, now);
      return { decisionId, conclusion, duplicate: false, ticketStatus: ticket.status };
    });
  }

  /** 推进业务时间：使所有未结束工单兑现截至 now 的到期转换。 */
  advanceTime(now: number): void {
    this.inTransaction(() => {
      const rows = this.db
        .prepare("SELECT ticket_id FROM tickets WHERE status = 'pending'")
        .all() as Array<{ ticket_id: string }>;
      for (const row of rows) {
        this.applyExpirations(this.mustLoadTicket(row.ticket_id), now);
      }
    });
  }

  /** 查看工单：先落实截至 now 的到期转换，再返回视图。 */
  getTicket(ticketId: string, now: number): TicketView {
    return this.inTransaction(() => {
      const ticket = this.mustLoadTicket(ticketId);
      this.applyExpirations(ticket, now);
      if (ticket.status !== 'pending') {
        return {
          ticketId,
          status: ticket.status,
          currentStageIndex: null,
          currentRound: null,
          agreedApprovers: [],
          deadline: null,
        };
      }
      const agreed = this.db
        .prepare(
          `SELECT approver FROM votes
           WHERE ticket_id = ? AND stage_index = ? AND round = ? AND approve = 1
           ORDER BY recorded_at, approver`,
        )
        .all(ticketId, ticket.current_stage_index, ticket.current_round) as Array<{
        approver: string;
      }>;
      return {
        ticketId,
        status: ticket.status,
        currentStageIndex: ticket.current_stage_index,
        currentRound: ticket.current_round,
        agreedApprovers: agreed.map((row) => row.approver),
        deadline: ticket.round_deadline,
      };
    });
  }

  /** 在单个事务内执行，保证结论、计票与阶段转换一起生效。 */
  private inTransaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private mustLoadTicket(ticketId: string): TicketRow {
    const row = this.db
      .prepare(
        `SELECT ticket_id, status, current_stage_index, current_round,
                round_started_at, round_deadline, created_at
         FROM tickets WHERE ticket_id = ?`,
      )
      .get(ticketId) as TicketRow | undefined;
    if (!row) {
      throw new Error(`ticket not found: ${ticketId}`);
    }
    return row;
  }

  /**
   * 落实截至 now 应发生的到期转换。普通轮到期切升级轮，
   * 升级轮从普通轮原截止时刻起算；一次跨过两个截止时刻
   * 则工单直接超时结束。截止时刻与决定同一毫秒时先处理到期。
   */
  private applyExpirations(ticket: TicketRow, now: number): void {
    while (
      ticket.status === 'pending' &&
      ticket.round_deadline !== null &&
      ticket.round_deadline <= now
    ) {
      if (ticket.current_round === 'normal') {
        const normalDeadline = ticket.round_deadline;
        this.updateRound(
          ticket,
          ticket.current_stage_index!,
          'escalated',
          normalDeadline,
          normalDeadline + ROUND_DURATION_MS,
        );
      } else {
        this.closeTicket(ticket, 'timeout');
      }
    }
  }

  /** 对当前状态受理一条新决定，返回结论并落实计票与转换。 */
  private adjudicate(ticket: TicketRow, input: SubmitDecisionInput): DecisionConclusion {
    const { ticketId, stageIndex, round, approver, approve, decisionId, now } = input;
    if (ticket.status !== 'pending') {
      return 'ticket-closed';
    }
    if (stageIndex !== ticket.current_stage_index || round !== ticket.current_round) {
      return 'stale-round';
    }
    const stage = this.db
      .prepare('SELECT approvers, escalated_approvers FROM stages WHERE ticket_id = ? AND stage_index = ?')
      .get(ticketId, stageIndex) as unknown as StageRow;
    const members: readonly string[] = JSON.parse(
      round === 'normal' ? stage.approvers : stage.escalated_approvers,
    );
    if (!members.includes(approver)) {
      return 'not-approver';
    }
    const priorVote = this.db
      .prepare(
        `SELECT 1 AS x FROM votes
         WHERE ticket_id = ? AND stage_index = ? AND round = ? AND approver = ?`,
      )
      .get(ticketId, stageIndex, round, approver);
    if (priorVote) {
      return 'already-voted';
    }

    this.db
      .prepare(
        `INSERT INTO votes
           (ticket_id, stage_index, round, approver, approve, decision_id, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(ticketId, stageIndex, round, approver, approve ? 1 : 0, decisionId, now);

    if (!approve) {
      this.closeTicket(ticket, 'rejected');
      return 'counted';
    }

    const agreedCount = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM votes
           WHERE ticket_id = ? AND stage_index = ? AND round = ? AND approve = 1`,
        )
        .get(ticketId, stageIndex, round) as { n: number }
    ).n;
    if (agreedCount < members.length) {
      return 'counted';
    }

    const stageCount = (
      this.db.prepare('SELECT COUNT(*) AS n FROM stages WHERE ticket_id = ?').get(ticketId) as {
        n: number;
      }
    ).n;
    if (stageIndex + 1 >= stageCount) {
      this.closeTicket(ticket, 'approved');
    } else {
      this.updateRound(ticket, stageIndex + 1, 'normal', now, now + ROUND_DURATION_MS);
    }
    return 'counted';
  }

  private updateRound(
    ticket: TicketRow,
    stageIndex: number,
    round: RoundKind,
    startedAt: number,
    deadline: number,
  ): void {
    this.db
      .prepare(
        `UPDATE tickets
         SET current_stage_index = ?, current_round = ?,
             round_started_at = ?, round_deadline = ?
         WHERE ticket_id = ?`,
      )
      .run(stageIndex, round, startedAt, deadline, ticket.ticket_id);
    ticket.current_stage_index = stageIndex;
    ticket.current_round = round;
    ticket.round_started_at = startedAt;
    ticket.round_deadline = deadline;
  }

  private closeTicket(ticket: TicketRow, status: TicketStatus): void {
    this.db
      .prepare(
        `UPDATE tickets
         SET status = ?, current_stage_index = NULL, current_round = NULL,
             round_started_at = NULL, round_deadline = NULL
         WHERE ticket_id = ?`,
      )
      .run(status, ticket.ticket_id);
    ticket.status = status;
    ticket.current_stage_index = null;
    ticket.current_round = null;
    ticket.round_started_at = null;
    ticket.round_deadline = null;
  }
}
