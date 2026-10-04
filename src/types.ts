/** 一轮审批的类型：普通轮或升级轮。 */
export type RoundKind = 'normal' | 'escalated';

/** 工单终态之外的进行状态用 pending 表示。 */
export type TicketStatus = 'pending' | 'approved' | 'rejected' | 'timeout';

/** 提交工单时单个阶段的定义。 */
export interface StageDefinition {
  /** 普通审批人集合，非空。 */
  readonly approvers: readonly string[];
  /** 升级审批人集合，非空。 */
  readonly escalatedApprovers: readonly string[];
}

/** 提交工单的入参。 */
export interface SubmitTicketInput {
  readonly ticketId: string;
  /** 1 至 5 个顺序执行的阶段。 */
  readonly stages: readonly StageDefinition[];
  /** 调用方提供的可信毫秒时刻，首阶段从此刻计时。 */
  readonly now: number;
}

/** 提交审批决定的入参。 */
export interface SubmitDecisionInput {
  readonly ticketId: string;
  /** 决定针对的阶段序号（0 起）。 */
  readonly stageIndex: number;
  /** 决定针对的轮次。 */
  readonly round: RoundKind;
  readonly approver: string;
  /** 工单内唯一的决定标识。 */
  readonly decisionId: string;
  /** true 为同意，false 为驳回。 */
  readonly approve: boolean;
  /** 调用方提供的可信毫秒时刻。 */
  readonly now: number;
}

/** 决定的受理结论。 */
export type DecisionConclusion =
  | 'counted' // 有效决定，已计票
  | 'duplicate' // 重投：返回首次受理结论（结论字段为首次结论）
  | 'stale-round' // 旧阶段或旧轮的迟到决定
  | 'not-approver' // 不是当前轮成员
  | 'already-voted' // 本轮已投过票，不能改票
  | 'ticket-closed'; // 工单已结束

/** 提交决定的返回结果。 */
export interface DecisionResult {
  readonly decisionId: string;
  /** 首次受理结论；重投时与首次一致。 */
  readonly conclusion: DecisionConclusion;
  /** 是否为重投（该标识此前已被受理过）。 */
  readonly duplicate: boolean;
  /** 本次调用落实到期转换并计票后的工单状态。 */
  readonly ticketStatus: TicketStatus;
}

/** 查看工单的返回视图。 */
export interface TicketView {
  readonly ticketId: string;
  readonly status: TicketStatus;
  /** 进行中：当前阶段序号；已结束：null。 */
  readonly currentStageIndex: number | null;
  /** 进行中：当前轮次；已结束：null。 */
  readonly currentRound: RoundKind | null;
  /** 当前轮已同意的人员（仅当前阶段当前轮，不混合历史）。 */
  readonly agreedApprovers: readonly string[];
  /** 当前轮截止时刻（毫秒）；已结束为 null。 */
  readonly deadline: number | null;
}

/** 每轮有效期：24 小时（毫秒）。 */
export const ROUND_DURATION_MS = 24 * 60 * 60 * 1000;
