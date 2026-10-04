/** 账户标识（客户或创作者）。 */
export type AccountId = string;
/** 项目标识。 */
export type ProjectId = string;
/** 里程碑标识（项目内唯一；已结束的标识不可复用）。 */
export type MilestoneId = string;
/** 幂等键，整个账本内唯一并绑定操作名称与业务参数。 */
export type OpKey = string;

/** 里程碑状态：pending=冻结中，resolved=已裁决，refunded=已随项目取消退款。 */
export type MilestoneStatus = "pending" | "resolved" | "refunded";
/** 项目状态：active=可用，cancelled=已取消。 */
export type ProjectStatus = "active" | "cancelled";

/** 初始化时传入的账户（可用余额，整数最小信用单位）。 */
export interface AccountInit {
  id: AccountId;
  available: number;
}

/** 初始化时传入的项目归属。 */
export interface ProjectInit {
  id: ProjectId;
  clientId: AccountId;
  creatorId: AccountId;
}

export interface LedgerInit {
  accounts: AccountInit[];
  projects: ProjectInit[];
  /** SQLite 文件路径；缺省为 ":memory:"。 */
  path?: string;
}

/** 操作结果：ok=false 时 error 为稳定错误码，账本不发生任何变更。 */
export type Result<T> = { ok: true; value: T } | { ok: false; error: LedgerError };

export type LedgerError =
  | "INSUFFICIENT_FUNDS"
  | "PROJECT_NOT_FOUND"
  | "PROJECT_CANCELLED"
  | "MILESTONE_EXISTS"
  | "MILESTONE_NOT_FOUND"
  | "MILESTONE_ENDED"
  | "INVALID_AMOUNT"
  | "INVALID_AWARD"
  | "KEY_CONFLICT"
  | "ALREADY_CANCELLED";

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
  refunded: number;
  refundedMilestones: MilestoneId[];
}

/** 资金流水条目：只追加，可从初始余额独立重放。 */
export interface FlowEntry {
  seq: number;
  key: OpKey;
  op: "init" | "reserve" | "resolve" | "cancel";
  projectId: ProjectId | null;
  milestoneId: MilestoneId | null;
  from: string;
  to: string;
  amount: number;
}

export interface AccountSnapshot {
  id: AccountId;
  available: number;
  earnings: number;
}

export interface MilestoneSnapshot {
  id: MilestoneId;
  projectId: ProjectId;
  status: MilestoneStatus;
  amount: number;
  award: number | null;
}

export interface ProjectSnapshot {
  id: ProjectId;
  clientId: AccountId;
  creatorId: AccountId;
  status: ProjectStatus;
}

export interface Snapshot {
  accounts: AccountSnapshot[];
  projects: ProjectSnapshot[];
  milestones: MilestoneSnapshot[];
  flows: FlowEntry[];
}
