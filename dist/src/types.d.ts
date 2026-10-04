/** 主机生命周期状态。 */
export declare enum HostState {
    Online = "online",
    Draining = "draining",
    Maintenance = "maintenance"
}
/** 资源二维向量：CPU 与内存。 */
export interface Resources {
    cpu: number;
    memory: number;
}
/** 池规格：该池每个会话固定消耗的资源。 */
export interface PoolSpec {
    poolId: string;
    perSession: Resources;
}
/** 初始化参数：主机容量与池规格。 */
export interface KernelConfig {
    hosts: Array<{
        hostId: string;
        capacity: Resources;
    }>;
    pools: PoolSpec[];
    /**
     * 目标主机的准备执行器：内核在建好预占后调用，
     * resolve 视为准备成功，reject/抛异常视为准备失败。
     * 缺省立即成功。
     */
    prepare?: (attempt: PreparationSnapshot) => Promise<void>;
}
/** 快照中的主机视图。 */
export interface HostSnapshot {
    hostId: string;
    state: HostState;
    capacity: Resources;
    /** 归属会话实际占用。 */
    used: Resources;
    /** 有效迁入预占。 */
    reserved: Resources;
    /** 归属本机的会话 id 列表。 */
    sessions: string[];
}
/** 快照中的会话视图。 */
export interface SessionSnapshot {
    sessionId: string;
    poolId: string;
    hostId: string;
}
/** 快照中的未提交准备（迁移预占）视图。 */
export interface PreparationSnapshot {
    attemptId: string;
    sessionId: string;
    fromHost: string;
    toHost: string;
}
/** 只读快照。 */
export interface KernelSnapshot {
    hosts: HostSnapshot[];
    sessions: SessionSnapshot[];
    preparations: PreparationSnapshot[];
}
export type PrepareResult = {
    ok: true;
} | {
    ok: false;
    reason: string;
};
export type AdmitResult = {
    ok: true;
    sessionId: string;
} | {
    ok: false;
    reason: string;
};
export type DrainResult = {
    ok: true;
} | {
    ok: false;
    reason: "blocked";
    remaining: number;
};
