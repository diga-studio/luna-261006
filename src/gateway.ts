import type {
  Action,
  ActionSink,
  BranchEventType,
  CallResult,
  CallStatus,
  ExtensionUsage,
} from "./types.js";

export interface GatewayOptions {
  /** 未接听超时毫秒数，默认 10000 */
  ringTimeoutMs?: number;
}

const DEFAULT_CAPACITY = 2;
const MAX_CAPACITY = 8;
const DEFAULT_RING_TIMEOUT_MS = 10_000;

/** 支路状态机：reserved -> ringing -> answered/canceling -> hangingup -> terminated */
type BranchState =
  | "reserved"    // 已预约名额，振铃尚未交付
  | "ringing"     // 振铃已交付，等待对方回应
  | "answered"    // 已接听（赢家）
  | "canceling"   // 已发撤销，等待拒接/线路结束回报
  | "hangingup"   // 已发挂断，等待线路结束回报
  | "terminated"; // 已终止，名额已释放

interface Branch {
  id: string;
  callId: string;
  extensionId: string;
  state: BranchState;
}

interface Call {
  id: string;
  startTime: number;
  deadline: number;
  branches: Branch[];
  winnerBranchId: string | null;
  /** 拆线流程已启动（超时/主叫结束/赢家线路结束） */
  ended: boolean;
  status: CallStatus;
  finalized: boolean;
}

interface Extension {
  id: string;
  capacity: number;
  used: number;
}

export class RingGateway {
  private readonly sink: ActionSink;
  private readonly ringTimeoutMs: number;
  private now = 0;
  private branchSeq = 0;

  private readonly extensions = new Map<string, Extension>();
  private readonly groups = new Map<string, string[]>();
  private readonly calls = new Map<string, Call>();
  private readonly branches = new Map<string, Branch>();

  constructor(sink: ActionSink, options?: GatewayOptions) {
    this.sink = sink;
    this.ringTimeoutMs = options?.ringTimeoutMs ?? DEFAULT_RING_TIMEOUT_MS;
  }

  addExtension(extensionId: string, capacity: number = DEFAULT_CAPACITY): void {
    if (this.extensions.has(extensionId)) {
      throw new Error(`extension already exists: ${extensionId}`);
    }
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > MAX_CAPACITY) {
      throw new Error(`capacity must be an integer between 1 and ${MAX_CAPACITY}`);
    }
    this.extensions.set(extensionId, { id: extensionId, capacity, used: 0 });
  }

  addRingGroup(groupId: string, extensionIds: string[]): void {
    if (this.groups.has(groupId)) {
      throw new Error(`ring group already exists: ${groupId}`);
    }
    for (const id of extensionIds) {
      if (!this.extensions.has(id)) {
        throw new Error(`unknown extension in group ${groupId}: ${id}`);
      }
    }
    this.groups.set(groupId, [...extensionIds]);
  }

  incomingCall(callId: string, groupId: string): CallResult {
    const memberIds = this.groups.get(groupId);
    if (!memberIds) {
      throw new Error(`unknown ring group: ${groupId}`);
    }
    if (this.calls.has(callId)) {
      throw new Error(`duplicate call id: ${callId}`);
    }

    const call: Call = {
      id: callId,
      startTime: this.now,
      deadline: this.now + this.ringTimeoutMs,
      branches: [],
      winnerBranchId: null,
      ended: false,
      status: "ringing",
      finalized: false,
    };
    this.calls.set(callId, call);

    // 为组内当前有余量的成员各预约一个名额；全满则忙线
    for (const extId of memberIds) {
      const ext = this.extensions.get(extId)!;
      if (ext.used < ext.capacity) {
        const branch: Branch = {
          id: `b${++this.branchSeq}`,
          callId,
          extensionId: extId,
          state: "reserved",
        };
        ext.used += 1;
        call.branches.push(branch);
        this.branches.set(branch.id, branch);
      }
    }

    if (call.branches.length === 0) {
      call.ended = true;
      call.status = "busy";
      call.finalized = true;
      return this.snapshot(call);
    }

    // 逐条交付振铃。交付回调可能重入报告事件（甚至直接接听并结束来电），
    // 因此每次交付前都重新检查支路是否仍处于 reserved。
    for (const branch of call.branches) {
      if (branch.state !== "reserved") continue;
      branch.state = "ringing";
      this.emit({ type: "ring", callId, branchId: branch.id, extensionId: branch.extensionId });
    }

    this.maybeFinalize(call);
    return this.snapshot(call);
  }

  report(branchId: string, event: BranchEventType): void {
    const branch = this.branches.get(branchId);
    if (!branch || branch.state === "terminated" || branch.state === "reserved") {
      return; // 已终止支路不得复活；未交付支路不接受事件
    }
    const call = this.calls.get(branch.callId)!;

    if (event === "answer") {
      this.onAnswer(call, branch);
    } else {
      this.onBranchEnd(call, branch);
    }
    this.maybeFinalize(call);
  }

  callerHangup(callId: string): void {
    const call = this.calls.get(callId);
    if (!call || call.ended) return;
    this.endCall(call);
    this.maybeFinalize(call);
  }

  advanceTime(now: number): void {
    if (now < this.now) {
      throw new Error("business time cannot move backwards");
    }
    this.now = now;
    // 未接听来电在截止时刻（含）超时；已有赢家的来电不再超时
    for (const call of this.calls.values()) {
      if (!call.ended && call.winnerBranchId === null && call.deadline <= now) {
        this.endCall(call);
        this.maybeFinalize(call);
      }
    }
  }

  getCallResult(callId: string): CallResult | null {
    const call = this.calls.get(callId);
    return call ? this.snapshot(call) : null;
  }

  getExtensionUsage(extensionId: string): ExtensionUsage | null {
    const ext = this.extensions.get(extensionId);
    return ext ? { extensionId: ext.id, capacity: ext.capacity, used: ext.used } : null;
  }

  private onAnswer(call: Call, branch: Branch): void {
    if (branch.state === "ringing" && !call.ended && call.winnerBranchId === null) {
      // 第一个有效接听成为唯一赢家，其余支路立即拆除
      branch.state = "answered";
      call.winnerBranchId = branch.id;
      call.status = "answered";
      this.teardownOthers(call, branch.id);
      return;
    }
    if (branch.state === "ringing" || branch.state === "canceling") {
      // 迟到接听：不能成为赢家，另发挂断
      branch.state = "hangingup";
      this.emit({ type: "hangup", callId: call.id, branchId: branch.id, extensionId: branch.extensionId });
    }
    // answered / hangingup 上的重复 answer 忽略，保证挂断至多一次
  }

  private onBranchEnd(call: Call, branch: Branch): void {
    if (branch.state === "reserved" || branch.state === "terminated") return;
    const wasWinner = call.winnerBranchId === branch.id;
    this.terminateBranch(branch);
    if (wasWinner) {
      // 赢家线路结束即结束整通来电，不改选赢家
      this.endCall(call);
    }
  }

  /** 启动整通拆线：未交付预约作废退还，已交付支路按状态撤销或挂断 */
  private endCall(call: Call): void {
    if (call.ended) return;
    call.ended = true;
    if (call.winnerBranchId !== null) {
      call.status = "ended";
    }
    this.teardownOthers(call, null);
  }

  private teardownOthers(call: Call, exceptBranchId: string | null): void {
    for (const branch of call.branches) {
      if (branch.id === exceptBranchId) continue;
      switch (branch.state) {
        case "reserved":
          // 尚未交付的振铃作废并退还预约，不能再交付
          this.terminateBranch(branch);
          break;
        case "ringing":
          branch.state = "canceling";
          this.emit({ type: "cancel", callId: call.id, branchId: branch.id, extensionId: branch.extensionId });
          break;
        case "answered":
          branch.state = "hangingup";
          this.emit({ type: "hangup", callId: call.id, branchId: branch.id, extensionId: branch.extensionId });
          break;
        default:
          break; // canceling / hangingup / terminated 保持原状
      }
    }
  }

  /** 终止支路并释放名额；每条例支路只会释放一次 */
  private terminateBranch(branch: Branch): void {
    if (branch.state === "terminated") return;
    branch.state = "terminated";
    const ext = this.extensions.get(branch.extensionId)!;
    ext.used -= 1;
  }

  private maybeFinalize(call: Call): void {
    if (call.finalized) return;
    if (!call.branches.every((b) => b.state === "terminated")) return;
    call.finalized = true;
    call.ended = true;
    if (call.winnerBranchId === null) {
      call.status = "no-answer";
    } else if (call.status !== "ended") {
      call.status = "ended";
    }
  }

  private snapshot(call: Call): CallResult {
    const winnerBranch = call.winnerBranchId
      ? this.branches.get(call.winnerBranchId) ?? null
      : null;
    return {
      callId: call.id,
      status: call.status,
      winner: winnerBranch ? winnerBranch.extensionId : null,
      finalized: call.finalized,
    };
  }

  private emit(action: Action): void {
    this.sink(action);
  }
}
