/** 分机标识 */
export type ExtensionId = string;
/** 振铃组标识 */
export type GroupId = string;
/** 来电标识，由调用方指定 */
export type CallId = string;

/** 业务时间，毫秒，由调用方显式推进 */
export type BusinessTime = number;

/** 支路状态 */
export type BranchState =
  | 'reserved'       // 已预约名额，振铃尚未交付
  | 'ringing'        // 振铃已交付，未接听
  | 'answered'       // 已接听（赢家）
  | 'cancelPending'  // 已发撤销，等待终止回报
  | 'hangupPending'  // 已发挂断，等待终止回报
  | 'terminated';    // 已终止，名额已释放

/** 交付给调用方的动作 */
export type GatewayAction =
  | { type: 'ring'; callId: CallId; extensionId: ExtensionId }
  | { type: 'cancel'; callId: CallId; extensionId: ExtensionId }
  | { type: 'hangup'; callId: CallId; extensionId: ExtensionId };

export type ActionSink = (action: GatewayAction) => void;

/** 来电结果 */
export type CallResult =
  | { status: 'ringing' }
  | { status: 'established'; winner: ExtensionId }
  | { status: 'answered-ended'; winner: ExtensionId }
  | { status: 'unanswered' }
  | { status: 'busy' };

/** 分机占用情况 */
export interface ExtensionUsage {
  extensionId: ExtensionId;
  capacity: number;
  occupied: number;
  available: number;
}
