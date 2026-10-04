/** 动作类型：振铃 / 撤销振铃 / 挂断 */
export type ActionType = "ring" | "cancel" | "hangup";

/** 交付给调用方的动作 */
export interface Action {
  type: ActionType;
  callId: string;
  branchId: string;
  extensionId: string;
}

/** 支路回报事件类型 */
export type BranchEventType = "answer" | "reject" | "lineEnd";

/** 来电结果状态 */
export type CallStatus =
  | "ringing"      // 至少一条支路未终止，尚无赢家
  | "answered"     // 已有赢家，通话进行中
  | "no-answer"    // 所有支路终止且无赢家（含超时、主叫结束、全部被拒）
  | "busy"         // 发起时组内无任何余量
  | "ended";       // 赢家线路结束，整通来电结束

export interface CallResult {
  callId: string;
  status: CallStatus;
  /** 赢家分机，未产生赢家时为 null */
  winner: string | null;
  /** 是否已彻底结束（所有支路终止） */
  finalized: boolean;
}

export interface ExtensionUsage {
  extensionId: string;
  capacity: number;
  used: number;
}

/** 调用方提供的动作交付回调；允许在回调返回前重入报告事件 */
export type ActionSink = (action: Action) => void;
