/** 金额一律为整数最小信用单位。 */

export type AccountId = string;
export type ProjectId = string;
export type MilestoneId = string;
export type OpKey = string;

export interface AccountInit {
  accountId: AccountId;
  /** 初始可用余额（一次性提供，之后不充值）。 */
  available: number;
}

export interface ProjectInit {
  projectId: ProjectId;
  clientId: AccountId;
  creatorId: AccountId;
}

export interface LedgerInit {
  accounts: AccountInit[];
  projects: ProjectInit[];
}

export type ProjectStatus = "open" | "cancelled";
export type MilestoneStatus = "frozen" | "resolved" | "refunded";

export type OpName = "reserve" | "resolve" | "cancel";

export type FailureReason =
  | "duplicate_key_conflict"
  | "unknown_project"
  | "project_cancelled"
  | "milestone_exists"
  | "milestone_not_found"
  | "milestone_already_final"
  | "insufficient_funds"
  | "invalid_amount"
  | "award_out_of_range"
  | "invalid_init";

export interface Ok<T> {
  ok: true;
  value: T;
}
export interface Err {
  ok: false;
  reason: FailureReason;
}
export type Result<T> = Ok<T> | Err;

export interface ReserveResult {
  projectId: ProjectId;
  milestoneId: MilestoneId;
  amount: number;
}

export interface ResolveResult {
  projectId: ProjectId;
  milestoneId: MilestoneId;
  award: number;
  refunded: number;
}

export interface CancelResult {
  projectId: ProjectId;
  refundedTotal: number;
  refundedMilestones: MilestoneId[];
}

/** 资金流水中的一笔移动。 */
export interface LedgerEntry {
  seq: number;
  key: OpKey;
  op: OpName | "init";
  /** 资金来源，如 account:acc1:available / milestone:p1:m1 / external:init */
  source: string;
  /** 资金去向 */
  destination: string;
  amount: number;
}

export interface AccountSnapshot {
  accountId: AccountId;
  available: number;
  earnings: number;
}

export interface MilestoneSnapshot {
  projectId: ProjectId;
  milestoneId: MilestoneId;
  amount: number;
  status: MilestoneStatus;
  award: number | null;
}

export interface ProjectSnapshot {
  projectId: ProjectId;
  clientId: AccountId;
  creatorId: AccountId;
  status: ProjectStatus;
}

export interface Snapshot {
  accounts: AccountSnapshot[];
  projects: ProjectSnapshot[];
  milestones: MilestoneSnapshot[];
  entries: LedgerEntry[];
  /** 初始信用总额（不变量校验用）。 */
  totalSupply: number;
}
