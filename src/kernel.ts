import {
  AdmitResult,
  DrainResult,
  HostSpec,
  HostState,
  PoolSpec,
  ResourceVector,
  Snapshot,
  HostView,
  SessionView,
  ReservationView,
} from './types';

interface HostEntry {
  spec: HostSpec;
  state: HostState;
  /** 归属本机的未关闭会话。 */
  sessions: Set<string>;
  /** 有效迁入预占：attemptId -> 预占资源。 */
  reservations: Map<string, ResourceVector>;
}

interface SessionEntry {
  sessionId: string;
  poolId: string;
  hostId: string;
  vector: ResourceVector;
  closed: boolean;
}

interface PendingAttempt {
  attemptId: string;
  sessionId: string;
  fromHost: string;
  toHost: string;
  vector: ResourceVector;
  invalidated: boolean;
  settled: boolean;
  resolve: (ok: boolean) => void;
}

const zero: ResourceVector = { cpu: 0, memory: 0 };

function add(a: ResourceVector, b: ResourceVector): ResourceVector {
  return { cpu: a.cpu + b.cpu, memory: a.memory + b.memory };
}

function fits(capacity: ResourceVector, load: ResourceVector): boolean {
  return load.cpu <= capacity.cpu && load.memory <= capacity.memory;
}

/**
 * ThinLink 主机维护迁移内核。
 *
 * 状态全部驻内存。所有状态变更都在同步临界区内完成，
 * 快照不会暴露相互矛盾的中间态。
 */
export class MigrationKernel {
  private readonly hosts = new Map<string, HostEntry>();
  private readonly pools = new Map<string, PoolSpec>();
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly attempts = new Map<string, PendingAttempt>();
  private sessionSeq = 0;

  constructor(hosts: HostSpec[], pools: PoolSpec[]) {
    for (const spec of hosts) {
      this.hosts.set(spec.hostId, {
        spec,
        state: 'online',
        sessions: new Set(),
        reservations: new Map(),
      });
    }
    for (const pool of pools) {
      this.pools.set(pool.poolId, pool);
    }
  }

  /** 在指定在线主机创建会话；容量不足或主机不可用返回 null。 */
  admit(poolId: string, hostId: string): AdmitResult {
    const pool = this.pools.get(poolId);
    const host = this.hosts.get(hostId);
    if (!pool || !host || host.state !== 'online') return null;
    const vector: ResourceVector = { cpu: pool.cpu, memory: pool.memory };
    if (!this.hasRoom(host, vector)) return null;
    const sessionId = `sess-${++this.sessionSeq}`;
    host.sessions.add(sessionId);
    this.sessions.set(sessionId, {
      sessionId,
      poolId,
      hostId,
      vector,
      closed: false,
    });
    return sessionId;
  }

  /** 关闭会话，幂等。 */
  close(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.closed) return;
    session.closed = true;
    this.hosts.get(session.hostId)?.sessions.delete(sessionId);
    // 关闭源会话：立即作废其未提交准备并释放目标预占。
    for (const attempt of this.attempts.values()) {
      if (!attempt.settled && attempt.sessionId === sessionId) {
        this.invalidate(attempt);
      }
    }
  }

  /** 排空主机：进入迁出中；已空则转维护中。 */
  drain(hostId: string): DrainResult {
    const host = this.hosts.get(hostId);
    if (!host) return 'blocked';
    if (host.state === 'maintenance') return 'success';
    host.state = 'draining';
    // 目标进入迁出中：立即作废未提交准备并释放目标预占。
    for (const attempt of this.attempts.values()) {
      if (!attempt.settled && attempt.toHost === hostId) {
        this.invalidate(attempt);
      }
    }
    if (host.sessions.size === 0) {
      host.state = 'maintenance';
      return 'success';
    }
    return 'blocked';
  }

  /**
   * 发起一次迁移准备，异步返回准备成功或失败（异常也算失败）。
   * 校验通过后立即在目标预占容量；异步回报时若准备仍有效则提交归属交接。
   */
  prepareMigration(
    attemptId: string,
    sessionId: string,
    fromHost: string,
    toHost: string,
  ): Promise<boolean> {
    try {
      const attempt = this.beginAttempt(attemptId, sessionId, fromHost, toHost);
      if (!attempt) return Promise.resolve(false);
      return new Promise<boolean>((resolve) => {
        attempt.resolve = resolve;
        setTimeout(() => this.settle(attempt), 0);
      });
    } catch {
      return Promise.resolve(false);
    }
  }

  /** 只读快照：主机状态、会话归属、实际占用与迁移预占。 */
  snapshot(): Snapshot {
    const hosts = new Map<string, HostView>();
    for (const [hostId, host] of this.hosts) {
      hosts.set(hostId, {
        hostId,
        state: host.state,
        used: this.usedBy(host),
        reserved: this.reservedBy(host),
        sessions: [...host.sessions],
      });
    }
    const sessions = new Map<string, SessionView>();
    for (const [sessionId, session] of this.sessions) {
      if (session.closed) continue;
      sessions.set(sessionId, {
        sessionId,
        poolId: session.poolId,
        hostId: session.hostId,
      });
    }
    const reservations = new Map<string, ReservationView>();
    for (const attempt of this.attempts.values()) {
      if (attempt.settled || attempt.invalidated) continue;
      reservations.set(attempt.attemptId, {
        attemptId: attempt.attemptId,
        sessionId: attempt.sessionId,
        fromHost: attempt.fromHost,
        toHost: attempt.toHost,
      });
    }
    return { hosts, sessions, reservations };
  }

  private beginAttempt(
    attemptId: string,
    sessionId: string,
    fromHost: string,
    toHost: string,
  ): PendingAttempt | null {
    if (this.attempts.has(attemptId)) return null;
    if (fromHost === toHost) return null;
    const session = this.sessions.get(sessionId);
    if (!session || session.closed || session.hostId !== fromHost) return null;
    const target = this.hosts.get(toHost);
    if (!target || target.state !== 'online') return null;
    // 每个会话同一时间最多一个未提交准备。
    for (const other of this.attempts.values()) {
      if (!other.settled && !other.invalidated && other.sessionId === sessionId) {
        return null;
      }
    }
    if (!this.hasRoom(target, session.vector)) return null;
    const attempt: PendingAttempt = {
      attemptId,
      sessionId,
      fromHost,
      toHost,
      vector: session.vector,
      invalidated: false,
      settled: false,
      resolve: () => undefined,
    };
    target.reservations.set(attemptId, session.vector);
    this.attempts.set(attemptId, attempt);
    return attempt;
  }

  private settle(attempt: PendingAttempt): void {
    if (attempt.settled) return;
    attempt.settled = true;
    this.attempts.delete(attempt.attemptId);
    if (attempt.invalidated) {
      attempt.resolve(false);
      return;
    }
    const session = this.sessions.get(attempt.sessionId);
    const source = this.hosts.get(attempt.fromHost);
    const target = this.hosts.get(attempt.toHost);
    const stillValid =
      session !== undefined &&
      !session.closed &&
      session.hostId === attempt.fromHost &&
      source !== undefined &&
      target !== undefined &&
      target.state === 'online' &&
      target.reservations.has(attempt.attemptId);
    if (!stillValid) {
      this.invalidate(attempt);
      attempt.resolve(false);
      return;
    }
    // 提交归属交接：释放预占，移动会话。
    target!.reservations.delete(attempt.attemptId);
    source!.sessions.delete(attempt.sessionId);
    target!.sessions.add(attempt.sessionId);
    session!.hostId = attempt.toHost;
    attempt.resolve(true);
  }

  /** 作废未提交准备：立即释放目标预占；后续回报不得提交。 */
  private invalidate(attempt: PendingAttempt): void {
    if (attempt.invalidated) return;
    attempt.invalidated = true;
    this.hosts.get(attempt.toHost)?.reservations.delete(attempt.attemptId);
  }

  private usedBy(host: HostEntry): ResourceVector {
    let total = zero;
    for (const sessionId of host.sessions) {
      const session = this.sessions.get(sessionId);
      if (session && !session.closed) total = add(total, session.vector);
    }
    return total;
  }

  private reservedBy(host: HostEntry): ResourceVector {
    let total = zero;
    for (const vector of host.reservations.values()) {
      total = add(total, vector);
    }
    return total;
  }

  private hasRoom(host: HostEntry, vector: ResourceVector): boolean {
    const load = add(add(this.usedBy(host), this.reservedBy(host)), vector);
    return fits(host.spec, load);
  }
}
