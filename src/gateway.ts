import type {
  ActionSink,
  BranchState,
  BusinessTime,
  CallId,
  CallResult,
  ExtensionId,
  ExtensionUsage,
  GatewayAction,
  GroupId,
} from './types.js';

export interface GatewayOptions {
  /** 动作交付回调，必填 */
  onAction: ActionSink;
  /** 未接听超时毫秒数，默认 10000 */
  ringTimeoutMs?: number;
}

interface ExtensionState {
  capacity: number;
  occupied: number;
}

interface Branch {
  readonly extensionId: ExtensionId;
  state: BranchState;
}

type CallEndReason = 'busy' | 'unanswered' | 'timeout' | 'caller' | 'winner-ended';

interface Call {
  readonly id: CallId;
  readonly groupId: GroupId;
  readonly deadline: BusinessTime;
  readonly branches: Map<ExtensionId, Branch>;
  winner: ExtensionId | null;
  ended: boolean;
  endReason: CallEndReason | null;
}

const MIN_CAPACITY = 1;
const MAX_CAPACITY = 8;
const DEFAULT_CAPACITY = 2;
const DEFAULT_RING_TIMEOUT_MS = 10_000;

export class RingGateway {
  private readonly extensions = new Map<ExtensionId, ExtensionState>();
  private readonly groups = new Map<GroupId, ExtensionId[]>();
  private readonly calls = new Map<CallId, Call>();
  private readonly onAction: ActionSink;
  private readonly ringTimeoutMs: number;
  private now: BusinessTime = 0;

  constructor(options: GatewayOptions) {
    if (typeof options?.onAction !== 'function') {
      throw new TypeError('RingGateway requires options.onAction callback');
    }
    this.onAction = options.onAction;
    this.ringTimeoutMs = options.ringTimeoutMs ?? DEFAULT_RING_TIMEOUT_MS;
    if (!(this.ringTimeoutMs > 0)) {
      throw new RangeError('ringTimeoutMs must be positive');
    }
  }

  registerExtension(extensionId: ExtensionId, capacity: number = DEFAULT_CAPACITY): void {
    if (this.extensions.has(extensionId)) {
      throw new Error(`extension already registered: ${extensionId}`);
    }
    if (!Number.isInteger(capacity) || capacity < MIN_CAPACITY || capacity > MAX_CAPACITY) {
      throw new RangeError(`capacity must be an integer between ${MIN_CAPACITY} and ${MAX_CAPACITY}`);
    }
    this.extensions.set(extensionId, { capacity, occupied: 0 });
  }

  registerGroup(groupId: GroupId, members: readonly ExtensionId[]): void {
    if (this.groups.has(groupId)) {
      throw new Error(`group already registered: ${groupId}`);
    }
    const unique: ExtensionId[] = [];
    for (const member of members) {
      if (!this.extensions.has(member)) {
        throw new Error(`group ${groupId} references unknown extension: ${member}`);
      }
      if (!unique.includes(member)) unique.push(member);
    }
    this.groups.set(groupId, unique);
  }

  incomingCall(callId: CallId, groupId: GroupId): CallResult {
    if (this.calls.has(callId)) {
      throw new Error(`duplicate call id: ${callId}`);
    }
    const members = this.groups.get(groupId);
    if (!members) {
      throw new Error(`unknown group: ${groupId}`);
    }
    const call: Call = {
      id: callId,
      groupId,
      deadline: this.now + this.ringTimeoutMs,
      branches: new Map(),
      winner: null,
      ended: false,
      endReason: null,
    };
    this.calls.set(callId, call);

    for (const extensionId of members) {
      const ext = this.extensions.get(extensionId);
      if (ext && ext.occupied < ext.capacity) {
        ext.occupied += 1;
        call.branches.set(extensionId, { extensionId, state: 'reserved' });
      }
    }

    if (call.branches.size === 0) {
      call.ended = true;
      call.endReason = 'busy';
      return { status: 'busy' };
    }

    // 逐条交付振铃；回调可能重入并改变状态，每次交付前重新检查。
    for (const branch of call.branches.values()) {
      if (call.ended || call.winner !== null) break;
      if (branch.state !== 'reserved') continue;
      branch.state = 'ringing';
      this.emit({ type: 'ring', callId, extensionId: branch.extensionId });
    }

    this.finishIfUnanswered(call);
    return this.resultOf(call);
  }

  reportAnswer(callId: CallId, extensionId: ExtensionId): void {
    const branch = this.branchOf(callId, extensionId);
    if (!branch) return;
    const call = this.calls.get(callId)!;
    switch (branch.state) {
      case 'ringing':
        if (!call.ended && call.winner === null) {
          this.selectWinner(call, branch);
        } else {
          // 已结束或已有赢家时的迟到接听：挂断，不成为赢家。
          branch.state = 'hangupPending';
          this.emit({ type: 'hangup', callId, extensionId });
        }
        break;
      case 'cancelPending':
        // 撤销途中的迟到接听：另发挂断，不能成为赢家。
        branch.state = 'hangupPending';
        this.emit({ type: 'hangup', callId, extensionId });
        break;
      default:
        // reserved / answered / hangupPending / terminated：忽略。
        break;
    }
  }

  reportReject(callId: CallId, extensionId: ExtensionId): void {
    const branch = this.branchOf(callId, extensionId);
    if (!branch) return;
    const call = this.calls.get(callId)!;
    if (branch.state === 'ringing' || branch.state === 'cancelPending' || branch.state === 'hangupPending') {
      this.terminate(call, branch);
      this.finishIfUnanswered(call);
    }
  }

  reportLineEnd(callId: CallId, extensionId: ExtensionId): void {
    const branch = this.branchOf(callId, extensionId);
    if (!branch) return;
    const call = this.calls.get(callId)!;
    if (branch.state === 'reserved' || branch.state === 'terminated') return;
    const wasWinner = call.winner === extensionId;
    this.terminate(call, branch);
    if (wasWinner) {
      // 赢家线路结束即结束整通来电，不改选赢家。
      call.ended = true;
      call.endReason = 'winner-ended';
    } else {
      this.finishIfUnanswered(call);
    }
  }

  callerHangup(callId: CallId): void {
    const call = this.calls.get(callId);
    if (!call || call.ended) return;
    call.ended = true;
    call.endReason = 'caller';
    this.teardown(call);
  }

  advanceTime(now: BusinessTime): void {
    if (now < this.now) {
      throw new RangeError('business time cannot move backward');
    }
    this.now = now;
    for (const call of [...this.calls.values()]) {
      if (!call.ended && call.winner === null && call.deadline <= now) {
        call.ended = true;
        call.endReason = 'timeout';
        this.teardown(call);
      }
    }
  }

  getCallResult(callId: CallId): CallResult | undefined {
    const call = this.calls.get(callId);
    return call ? this.resultOf(call) : undefined;
  }

  getWinner(callId: CallId): ExtensionId | undefined {
    return this.calls.get(callId)?.winner ?? undefined;
  }

  getExtensionUsage(extensionId: ExtensionId): ExtensionUsage | undefined {
    const ext = this.extensions.get(extensionId);
    if (!ext) return undefined;
    return {
      extensionId,
      capacity: ext.capacity,
      occupied: ext.occupied,
      available: ext.capacity - ext.occupied,
    };
  }

  private branchOf(callId: CallId, extensionId: ExtensionId): Branch | undefined {
    return this.calls.get(callId)?.branches.get(extensionId);
  }

  private selectWinner(call: Call, branch: Branch): void {
    call.winner = branch.extensionId;
    branch.state = 'answered';
    for (const other of call.branches.values()) {
      if (other === branch) continue;
      if (other.state === 'reserved') {
        // 尚未交付的振铃作废并退还预约。
        this.terminate(call, other);
      } else if (other.state === 'ringing') {
        other.state = 'cancelPending';
        this.emit({ type: 'cancel', callId: call.id, extensionId: other.extensionId });
      }
    }
  }

  private teardown(call: Call): void {
    for (const branch of call.branches.values()) {
      if (branch.state === 'reserved') {
        this.terminate(call, branch);
      } else if (branch.state === 'ringing') {
        branch.state = 'cancelPending';
        this.emit({ type: 'cancel', callId: call.id, extensionId: branch.extensionId });
      } else if (branch.state === 'answered') {
        branch.state = 'hangupPending';
        this.emit({ type: 'hangup', callId: call.id, extensionId: branch.extensionId });
      }
    }
  }

  private terminate(call: Call, branch: Branch): void {
    if (branch.state === 'terminated') return;
    branch.state = 'terminated';
    const ext = this.extensions.get(branch.extensionId);
    if (ext) ext.occupied -= 1;
    void call;
  }

  private finishIfUnanswered(call: Call): void {
    if (call.ended || call.winner !== null) return;
    for (const branch of call.branches.values()) {
      if (branch.state !== 'terminated') return;
    }
    call.ended = true;
    call.endReason = 'unanswered';
  }

  private resultOf(call: Call): CallResult {
    if (call.winner !== null) {
      return call.ended
        ? { status: 'answered-ended', winner: call.winner }
        : { status: 'established', winner: call.winner };
    }
    if (call.ended) {
      return call.endReason === 'busy' ? { status: 'busy' } : { status: 'unanswered' };
    }
    return { status: 'ringing' };
  }

  private emit(action: GatewayAction): void {
    this.onAction(action);
  }
}
