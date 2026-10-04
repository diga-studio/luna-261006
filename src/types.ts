/** 一轮的类型：普通轮或升级轮 */
export type RoundType = 'normal' | 'escalation';

/** 决定的结论 */
export type Verdict = 'approve' | 'reject';

/** 工单终态 */
export type TerminalStatus = 'approved' | 'rejected' | 'expired';

/** 工单状态：进行中或某种终态 */
export type TicketStatus = 'open' | TerminalStatus;

/** 提交工单时的一个阶段定义 */
export interface StageSpec {
  /** 普通审批人集合（非空） */
  approvers: string[];
  /** 升级审批人集合（非空） */
  escalatedApprovers: string[];
}

/** 提交工单入参 */
export interface CreateTicketInput {
  /** 工单标识，调用方给定，库内唯一 */
  ticketId: string;
  /** 1 至 5 个顺序执行的阶段 */
  stages: StageSpec[];
}

/** 提交审批决定入参 */
export interface DecisionInput {
  ticketId: string;
  /** 决定针对的阶段下标（0 起） */
  stageIndex: number;
  /** 决定针对的轮次 */
  round: RoundType;
  approver: string;
  /** 决定标识，工单内唯一；重投内容相同 */
  decisionId: string;
  verdict: Verdict;
}

/** 决定的受理结论（重投时返回首次结论） */
export type DecisionConclusion =
  | 'accepted' // 有效决定，已计票
  | 'stale-round' // 不是当前轮（旧轮迟到或未来轮）
  | 'stale-stage' // 不是当前阶段
  | 'not-approver' // 不是当前轮成员
  | 'already-voted' // 本轮已投过（不同标识）
  | 'ticket-closed'; // 工单已结束（含到期转换后结束）

export interface DecisionResult {
  conclusion: DecisionConclusion;
  /** 受理后工单状态快照 */
  status: TicketStatus;
}

/** 查看工单的返回 */
export interface TicketView {
  ticketId: string;
  status: TicketStatus;
  /** 当前阶段下标；终态时为最后所处阶段 */
  stageIndex: number;
  /** 当前轮次；终态时为最后所处轮次 */
  round: RoundType;
  /** 当前轮已同意人员（终态时为终态发生那一轮已同意人员） */
  approvals: string[];
  /** 当前轮截止时刻（毫秒）；终态时为该轮截止时刻 */
  deadline: number;
}
