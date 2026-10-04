/** 主机生命周期状态。 */
export type HostState = 'online' | 'draining' | 'maintenance';

/** 资源二维向量（CPU / 内存）。 */
export interface ResourceVector {
  cpu: number;
  memory: number;
}

/** 池规格：该池每个会话固定消耗的资源。 */
export interface PoolSpec extends ResourceVector {
  poolId: string;
}

/** 主机规格：容量。 */
export interface HostSpec extends ResourceVector {
  hostId: string;
}

/** 会话只读视图。 */
export interface SessionView {
  sessionId: string;
  poolId: string;
  hostId: string;
}

/** 迁移预占只读视图（准备挂起期间可观察）。 */
export interface ReservationView {
  attemptId: string;
  sessionId: string;
  fromHost: string;
  toHost: string;
}

/** 主机只读视图。 */
export interface HostView {
  hostId: string;
  state: HostState;
  /** 归属会话的实际占用。 */
  used: ResourceVector;
  /** 有效迁入预占。 */
  reserved: ResourceVector;
  sessions: string[];
}

/** 全局只读快照。 */
export interface Snapshot {
  hosts: ReadonlyMap<string, HostView>;
  sessions: ReadonlyMap<string, SessionView>;
  reservations: ReadonlyMap<string, ReservationView>;
}

/** drain 结果。 */
export type DrainResult = 'success' | 'blocked';

/** admit 结果：成功返回 sessionId，失败返回 null。 */
export type AdmitResult = string | null;
