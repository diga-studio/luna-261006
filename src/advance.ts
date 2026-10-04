import { DatabaseSync } from 'node:sqlite';
import { inTransaction } from './db';
import { applyExpiry } from './expiry';

/** 推进业务时间：所有未结束工单兑现截至 now 的到期转换 */
export function advanceTime(db: DatabaseSync, now: number): void {
  inTransaction(db, () => {
    const rows = db.prepare("SELECT ticket_id FROM tickets WHERE status = 'open'").all() as Array<{
      ticket_id: string;
    }>;
    for (const row of rows) {
      applyExpiry(db, row.ticket_id, now);
    }
  });
}
