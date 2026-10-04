import { DatabaseSync } from 'node:sqlite';
import { ROUND_MS } from './db';

interface TicketRow {
  status: string;
  round: string;
  deadline: number;
}

/**
 * 落实单个工单截至 now 应发生的到期转换（须在事务内调用）。
 * 普通轮到期：切到升级轮，截止时刻 = 原截止时刻 + 24h（不清票，靠轮次键隔离旧票）。
 * 升级轮到期：整单超时结束。循环处理可一次跨过两个截止时刻。
 */
export function applyExpiry(db: DatabaseSync, ticketId: string, now: number): void {
  const row = db
    .prepare('SELECT status, round, deadline FROM tickets WHERE ticket_id = ?')
    .get(ticketId) as TicketRow | undefined;
  if (!row || row.status !== 'open') return;

  let round = row.round;
  let deadline = Number(row.deadline);
  let status = row.status;

  while (status === 'open' && now >= deadline) {
    if (round === 'normal') {
      round = 'escalation';
      deadline = deadline + ROUND_MS;
    } else {
      status = 'expired';
    }
  }

  if (status !== row.status || round !== row.round || deadline !== Number(row.deadline)) {
    db.prepare('UPDATE tickets SET status = ?, round = ?, deadline = ? WHERE ticket_id = ?').run(
      status,
      round,
      deadline,
      ticketId,
    );
  }
}
