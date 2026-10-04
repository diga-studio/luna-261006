"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HostState = exports.MigrationKernel = void 0;
const types_1 = require("./types");
Object.defineProperty(exports, "HostState", { enumerable: true, get: function () { return types_1.HostState; } });
function add(a, b) {
    return { cpu: a.cpu + b.cpu, memory: a.memory + b.memory };
}
function fits(capacity, used, reserved, extra) {
    return (used.cpu + reserved.cpu + extra.cpu <= capacity.cpu &&
        used.memory + reserved.memory + extra.memory <= capacity.memory);
}
/**
 * ThinLink 主机维护迁移内核。
 * 状态全部驻内存；所有状态变更在同步临界区内完成，
 * 快照不会暴露相互矛盾的中间状态。
 */
class MigrationKernel {
    hosts = new Map();
    pools = new Map();
    sessions = new Map();
    preparations = new Map();
    pending = new Map();
    prepare;
    sessionSeq = 0;
    constructor(config) {
        for (const h of config.hosts) {
            if (this.hosts.has(h.hostId))
                throw new Error(`duplicate host: ${h.hostId}`);
            this.hosts.set(h.hostId, {
                hostId: h.hostId,
                capacity: { ...h.capacity },
                state: types_1.HostState.Online,
            });
        }
        for (const p of config.pools) {
            if (this.pools.has(p.poolId))
                throw new Error(`duplicate pool: ${p.poolId}`);
            this.pools.set(p.poolId, { poolId: p.poolId, perSession: { ...p.perSession } });
        }
        this.prepare = config.prepare ?? (() => Promise.resolve());
    }
    /** 在指定在线主机创建会话，容量不足则拒绝。 */
    admit(poolId, hostId) {
        const pool = this.pools.get(poolId);
        if (!pool)
            return { ok: false, reason: `unknown pool: ${poolId}` };
        const host = this.hosts.get(hostId);
        if (!host)
            return { ok: false, reason: `unknown host: ${hostId}` };
        if (host.state !== types_1.HostState.Online) {
            return { ok: false, reason: `host ${hostId} is not online` };
        }
        if (!fits(host.capacity, this.usedOf(hostId), this.reservedOf(hostId), pool.perSession)) {
            return { ok: false, reason: `host ${hostId} has insufficient capacity` };
        }
        const sessionId = `s${++this.sessionSeq}`;
        this.sessions.set(sessionId, { sessionId, poolId, hostId });
        return { ok: true, sessionId };
    }
    /**
     * 关闭会话，重复调用无副作用。
     * 立即作废该会话的未提交准备并释放目标预占，同时释放源占用。
     */
    close(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session)
            return;
        for (const prep of [...this.preparations.values()]) {
            if (prep.sessionId === sessionId)
                this.preparations.delete(prep.attemptId);
        }
        this.sessions.delete(sessionId);
    }
    /**
     * 目标主机准备迁移：异步返回准备成功或失败，异常也算失败。
     * 仅报告目标准备结果；准备期间会话仍属源主机并占用源容量，
     * 同时在目标上形成预占。成功且仍有效时提交归属交接。
     */
    async prepareMigration(attemptId, sessionId, fromHost, toHost) {
        const check = this.tryReserve(attemptId, sessionId, fromHost, toHost);
        if (check !== null)
            return { ok: false, reason: check };
        const settle = this.settlePreparation(attemptId);
        this.pending.set(attemptId, settle);
        try {
            return await settle;
        }
        finally {
            this.pending.delete(attemptId);
        }
    }
    /** 等待目标准备回报并结算：成功且仍有效则提交归属交接。 */
    async settlePreparation(attemptId) {
        const prep0 = this.preparations.get(attemptId);
        if (!prep0)
            return { ok: false, reason: "preparation invalidated" };
        const { sessionId, fromHost, toHost } = prep0;
        let succeeded;
        try {
            await this.prepare({ attemptId, sessionId, fromHost, toHost });
            succeeded = true;
        }
        catch {
            succeeded = false;
        }
        // 结算：准备可能已在挂起期间被 close/drain 作废。
        const prep = this.preparations.get(attemptId);
        if (!prep)
            return { ok: false, reason: "preparation invalidated" };
        this.preparations.delete(attemptId);
        if (!succeeded)
            return { ok: false, reason: "target preparation failed" };
        // 提交归属交接：同一同步临界区内改归属并释放预占。
        const session = this.sessions.get(prep.sessionId);
        if (!session || session.hostId !== prep.fromHost) {
            return { ok: false, reason: "preparation invalidated" };
        }
        session.hostId = prep.toHost;
        return { ok: true };
    }
    /**
     * 排空主机：立即（同步）转为迁出中，禁止新建和迁入，
     * 并作废所有指向本机的未提交准备。随后本轮对每个会话最多
     * 尝试一次迁出；本轮结束时已空则进入维护中，否则返回受阻。
     */
    async drain(hostId) {
        const host = this.hosts.get(hostId);
        if (!host)
            throw new Error(`unknown host: ${hostId}`);
        if (host.state === types_1.HostState.Maintenance)
            return { ok: true };
        // 立即转迁出中，并作废指向本机的未提交准备、释放其预占。
        host.state = types_1.HostState.Draining;
        for (const prep of [...this.preparations.values()]) {
            if (prep.toHost === hostId)
                this.preparations.delete(prep.attemptId);
        }
        // 本轮迁出：每个当前归属会话最多尝试一次；已有挂起准备的
        // 会话直接等待该准备，不再重复尝试。
        const round = [];
        for (const session of [...this.sessions.values()]) {
            if (session.hostId !== hostId)
                continue;
            const existing = [...this.preparations.values()].find((p) => p.sessionId === session.sessionId);
            if (existing) {
                // 已有挂起准备：本轮不再重复尝试，但等待它结算。
                const inflight = this.pending.get(existing.attemptId);
                if (inflight)
                    round.push(inflight);
                continue;
            }
            const target = this.pickTarget(session.poolId, hostId);
            if (!target)
                continue; // 无可用目标，本轮受阻
            round.push(this.prepareMigration(`drain-${hostId}-${session.sessionId}`, session.sessionId, hostId, target));
        }
        await Promise.all(round);
        const remaining = this.sessionsOn(hostId).length;
        if (remaining === 0) {
            host.state = types_1.HostState.Maintenance;
            return { ok: true };
        }
        return { ok: false, reason: "blocked", remaining };
    }
    /** 返回只读快照；可在准备挂起期间观察。 */
    snapshot() {
        const hosts = [...this.hosts.values()].map((h) => ({
            hostId: h.hostId,
            state: h.state,
            capacity: { ...h.capacity },
            used: this.usedOf(h.hostId),
            reserved: this.reservedOf(h.hostId),
            sessions: this.sessionsOn(h.hostId).map((s) => s.sessionId),
        }));
        const sessions = [...this.sessions.values()].map((s) => ({ ...s }));
        const preparations = [...this.preparations.values()].map((p) => ({ ...p }));
        return { hosts, sessions, preparations };
    }
    /** 校验并建立预占；返回 null 表示成功，否则为失败原因。 */
    tryReserve(attemptId, sessionId, fromHost, toHost) {
        if (this.preparations.has(attemptId))
            return `duplicate attempt: ${attemptId}`;
        const session = this.sessions.get(sessionId);
        if (!session)
            return `unknown session: ${sessionId}`;
        if (session.hostId !== fromHost)
            return `session ${sessionId} is not on host ${fromHost}`;
        if (fromHost === toHost)
            return "source and target must differ";
        const target = this.hosts.get(toHost);
        if (!target)
            return `unknown host: ${toHost}`;
        if (target.state !== types_1.HostState.Online)
            return `host ${toHost} is not online`;
        for (const prep of this.preparations.values()) {
            if (prep.sessionId === sessionId)
                return `session ${sessionId} already has a pending preparation`;
        }
        const pool = this.pools.get(session.poolId);
        if (!pool)
            return `unknown pool: ${session.poolId}`;
        if (!fits(target.capacity, this.usedOf(toHost), this.reservedOf(toHost), pool.perSession)) {
            return `host ${toHost} has insufficient capacity`;
        }
        this.preparations.set(attemptId, { attemptId, sessionId, fromHost, toHost });
        return null;
    }
    /** 为会话挑选一台能容纳它的在线主机（不含 excludeHost）。 */
    pickTarget(poolId, excludeHost) {
        const pool = this.pools.get(poolId);
        if (!pool)
            return null;
        for (const host of this.hosts.values()) {
            if (host.hostId === excludeHost || host.state !== types_1.HostState.Online)
                continue;
            if (fits(host.capacity, this.usedOf(host.hostId), this.reservedOf(host.hostId), pool.perSession)) {
                return host.hostId;
            }
        }
        return null;
    }
    sessionsOn(hostId) {
        return [...this.sessions.values()].filter((s) => s.hostId === hostId);
    }
    usedOf(hostId) {
        let total = { cpu: 0, memory: 0 };
        for (const s of this.sessionsOn(hostId)) {
            const pool = this.pools.get(s.poolId);
            if (pool)
                total = add(total, pool.perSession);
        }
        return total;
    }
    reservedOf(hostId) {
        let total = { cpu: 0, memory: 0 };
        for (const prep of this.preparations.values()) {
            if (prep.toHost !== hostId)
                continue;
            const session = this.sessions.get(prep.sessionId);
            const pool = session ? this.pools.get(session.poolId) : undefined;
            if (pool)
                total = add(total, pool.perSession);
        }
        return total;
    }
}
exports.MigrationKernel = MigrationKernel;
