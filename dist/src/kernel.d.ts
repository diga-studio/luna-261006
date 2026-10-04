import { AdmitResult, DrainResult, HostState, KernelConfig, KernelSnapshot, PrepareResult } from "./types";
/**
 * ThinLink 主机维护迁移内核。
 * 状态全部驻内存；所有状态变更在同步临界区内完成，
 * 快照不会暴露相互矛盾的中间状态。
 */
export declare class MigrationKernel {
    private readonly hosts;
    private readonly pools;
    private readonly sessions;
    private readonly preparations;
    private readonly pending;
    private readonly prepare;
    private sessionSeq;
    constructor(config: KernelConfig);
    /** 在指定在线主机创建会话，容量不足则拒绝。 */
    admit(poolId: string, hostId: string): AdmitResult;
    /**
     * 关闭会话，重复调用无副作用。
     * 立即作废该会话的未提交准备并释放目标预占，同时释放源占用。
     */
    close(sessionId: string): void;
    /**
     * 目标主机准备迁移：异步返回准备成功或失败，异常也算失败。
     * 仅报告目标准备结果；准备期间会话仍属源主机并占用源容量，
     * 同时在目标上形成预占。成功且仍有效时提交归属交接。
     */
    prepareMigration(attemptId: string, sessionId: string, fromHost: string, toHost: string): Promise<PrepareResult>;
    /** 等待目标准备回报并结算：成功且仍有效则提交归属交接。 */
    private settlePreparation;
    /**
     * 排空主机：立即（同步）转为迁出中，禁止新建和迁入，
     * 并作废所有指向本机的未提交准备。随后本轮对每个会话最多
     * 尝试一次迁出；本轮结束时已空则进入维护中，否则返回受阻。
     */
    drain(hostId: string): Promise<DrainResult>;
    /** 返回只读快照；可在准备挂起期间观察。 */
    snapshot(): KernelSnapshot;
    /** 校验并建立预占；返回 null 表示成功，否则为失败原因。 */
    private tryReserve;
    /** 为会话挑选一台能容纳它的在线主机（不含 excludeHost）。 */
    private pickTarget;
    private sessionsOn;
    private usedOf;
    private reservedOf;
}
export { HostState };
