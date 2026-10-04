import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./db";
import { InputStore } from "./input";
import { SettlementEngine } from "./settlement";
import type { BatchInfo, MemberResult, MonthKey } from "./types";

export * from "./types";

export class CommissionSettlement {
  private readonly db: DatabaseSync;
  private readonly input: InputStore;
  private readonly engine: SettlementEngine;

  constructor(dbPath: string) {
    this.db = openDatabase(dbPath);
    this.input = new InputStore(this.db);
    this.engine = new SettlementEngine(this.db);
  }

  close(): void {
    this.db.close();
  }

  upsertMember(memberId: string, sponsorId: string | null): void {
    this.input.upsertMember(memberId, sponsorId);
  }

  setMonthlyPv(memberId: string, month: MonthKey, pv: number): void {
    this.input.setMonthlyPv(memberId, month, pv);
  }

  initiateSettlement(month: MonthKey): BatchInfo {
    return this.engine.initiate(month);
  }

  advanceSettlement(month: MonthKey, maxMembers?: number): BatchInfo {
    return this.engine.advance(month, maxMembers);
  }

  getSettlementStatus(month: MonthKey): BatchInfo | null {
    return this.engine.getStatus(month);
  }

  getMemberResult(month: MonthKey, memberId: string): MemberResult | null {
    return this.engine.getMemberResult(month, memberId);
  }

  getAllResults(month: MonthKey): MemberResult[] | null {
    return this.engine.getAllResults(month);
  }
}
