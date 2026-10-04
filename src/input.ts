import type { DatabaseSync } from "node:sqlite";
import type { MonthKey } from "./types";

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function assertValidMonth(month: MonthKey): void {
  if (typeof month !== "string" || !MONTH_RE.test(month)) {
    throw new Error(`invalid month key: ${JSON.stringify(month)} (expected "YYYY-MM")`);
  }
}

export class InputStore {
  constructor(private readonly db: DatabaseSync) {}

  upsertMember(memberId: string, sponsorId: string | null): void {
    if (typeof memberId !== "string" || memberId.length === 0) {
      throw new Error("memberId must be a non-empty string");
    }
    if (sponsorId !== null && (typeof sponsorId !== "string" || sponsorId.length === 0)) {
      throw new Error("sponsorId must be null or a non-empty string");
    }
    if (sponsorId === memberId) {
      throw new Error("a member cannot sponsor itself");
    }
    this.db
      .prepare(
        `INSERT INTO members (member_id, sponsor_id)
         VALUES (?, ?)
         ON CONFLICT(member_id) DO UPDATE SET sponsor_id = excluded.sponsor_id`
      )
      .run(memberId, sponsorId);
  }

  setMonthlyPv(memberId: string, month: MonthKey, pv: number): void {
    if (typeof memberId !== "string" || memberId.length === 0) {
      throw new Error("memberId must be a non-empty string");
    }
    assertValidMonth(month);
    if (!Number.isInteger(pv) || pv < 0 || pv > 99999) {
      throw new Error("pv must be an integer between 0 and 99999");
    }
    this.db
      .prepare(
        `INSERT INTO monthly_pv (member_id, month, pv)
         VALUES (?, ?, ?)
         ON CONFLICT(member_id, month) DO UPDATE SET pv = excluded.pv`
      )
      .run(memberId, month, pv);
  }
}
