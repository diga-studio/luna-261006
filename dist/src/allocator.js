"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Allocator = exports.MAX_ATTEMPTS = exports.SECOND_RETRY_DELAY_MS = exports.FIRST_RETRY_DELAY_MS = exports.ATTEMPT_TIMEOUT_MS = void 0;
/** 单次尝试的等待期限（毫秒）。 */
exports.ATTEMPT_TIMEOUT_MS = 3000;
/** 第一次重试前的等待（毫秒）。 */
exports.FIRST_RETRY_DELAY_MS = 200;
/** 第二次重试前的等待（毫秒）。 */
exports.SECOND_RETRY_DELAY_MS = 400;
/** 每个请求的最大尝试次数。 */
exports.MAX_ATTEMPTS = 3;
/**
 * TrafficForge 请求分配器：单后端池，配置与运行状态均保存在进程内。
 */
class Allocator {
    executor;
    attemptTimeoutMs;
    retryDelaysMs;
    maxAttempts;
    /** 当前配置：targetId -> maxConcurrency。 */
    config = new Map();
    /** 占用：targetId -> 进行中的尝试数（含已移除目标的残留占用）。 */
    inFlight = new Map();
    constructor(executor, options = {}) {
        this.executor = executor;
        this.attemptTimeoutMs = options.attemptTimeoutMs ?? exports.ATTEMPT_TIMEOUT_MS;
        this.retryDelaysMs = options.retryDelaysMs ?? [
            exports.FIRST_RETRY_DELAY_MS,
            exports.SECOND_RETRY_DELAY_MS,
        ];
        this.maxAttempts = options.maxAttempts ?? exports.MAX_ATTEMPTS;
    }
    /** 整体替换目标配置。 */
    replaceConfig(targets) {
        const next = new Map();
        for (const target of targets) {
            if (next.has(target.id)) {
                throw new Error(`duplicate target id: ${target.id}`);
            }
            if (!Number.isInteger(target.maxConcurrency) ||
                target.maxConcurrency < 1) {
                throw new Error(`invalid maxConcurrency for target ${target.id}: ${target.maxConcurrency}`);
            }
            next.set(target.id, target.maxConcurrency);
        }
        this.config = next;
    }
    /** 查询当前占用（含已移除但仍有占用的目标）。 */
    occupancy() {
        const ids = new Set([...this.config.keys(), ...this.inFlight.keys()]);
        const entries = [];
        for (const targetId of ids) {
            const inFlight = this.inFlight.get(targetId) ?? 0;
            const max = this.config.get(targetId);
            entries.push({
                targetId,
                inFlight,
                maxConcurrency: max === undefined ? null : max,
            });
        }
        entries.sort((a, b) => (a.targetId < b.targetId ? -1 : a.targetId > b.targetId ? 1 : 0));
        return entries;
    }
    /** 提交一个可取消的请求。 */
    submit() {
        const triedTargetIds = new Set();
        const liveAttempts = new Set();
        let settled = false;
        let retryTimer = null;
        let attemptsUsed = 0;
        let resolveResult;
        const result = new Promise((resolve) => {
            resolveResult = resolve;
        });
        const settle = (final) => {
            if (settled)
                return;
            settled = true;
            if (retryTimer !== null) {
                clearTimeout(retryTimer);
                retryTimer = null;
            }
            for (const attempt of liveAttempts) {
                attempt.signal.cancelled = true;
            }
            resolveResult(final);
        };
        const releaseOccupancy = (targetId) => {
            const current = this.inFlight.get(targetId);
            if (current === undefined)
                return;
            if (current <= 1) {
                this.inFlight.delete(targetId);
            }
            else {
                this.inFlight.set(targetId, current - 1);
            }
        };
        const pickTarget = () => {
            let best = null;
            let bestLoad = Infinity;
            for (const [id, max] of this.config) {
                if (triedTargetIds.has(id))
                    continue;
                const load = this.inFlight.get(id) ?? 0;
                if (load >= max)
                    continue;
                if (load < bestLoad || (load === bestLoad && (best === null || id < best))) {
                    best = id;
                    bestLoad = load;
                }
            }
            return best;
        };
        const finishAttempt = (attempt, outcome) => {
            if (attempt.finished)
                return;
            attempt.finished = true;
            if (attempt.timeoutTimer !== null) {
                clearTimeout(attempt.timeoutTimer);
                attempt.timeoutTimer = null;
            }
            liveAttempts.delete(attempt);
            releaseOccupancy(attempt.targetId);
            if (settled || attempt.timedOut) {
                // 迟到结果：只释放占用，不改变请求结果，不触发重试。
                return;
            }
            if (outcome === "success") {
                settle({ status: "success" });
                return;
            }
            scheduleNext();
        };
        const scheduleNext = () => {
            if (settled)
                return;
            if (attemptsUsed >= this.maxAttempts) {
                settle({ status: "failure" });
                return;
            }
            if (attemptsUsed === 0) {
                startAttempt();
                return;
            }
            const delay = this.retryDelaysMs[attemptsUsed - 1] ?? 0;
            retryTimer = setTimeout(() => {
                retryTimer = null;
                startAttempt();
            }, delay);
        };
        const startAttempt = () => {
            if (settled)
                return;
            const targetId = pickTarget();
            if (targetId === null) {
                settle({ status: "no-available-target" });
                return;
            }
            triedTargetIds.add(targetId);
            attemptsUsed += 1;
            this.inFlight.set(targetId, (this.inFlight.get(targetId) ?? 0) + 1);
            const attempt = {
                targetId,
                signal: { cancelled: false },
                finished: false,
                timedOut: false,
                timeoutTimer: null,
            };
            liveAttempts.add(attempt);
            attempt.timeoutTimer = setTimeout(() => {
                attempt.timeoutTimer = null;
                if (attempt.finished)
                    return;
                attempt.timedOut = true;
                attempt.signal.cancelled = true;
                // 占用不释放，等执行器真正结束；但可立即进入重试等待。
                scheduleNext();
            }, this.attemptTimeoutMs);
            let outcomePromise;
            try {
                outcomePromise = Promise.resolve(this.executor(targetId, attempt.signal));
            }
            catch {
                outcomePromise = Promise.resolve("failure");
            }
            outcomePromise.then((outcome) => finishAttempt(attempt, outcome === "success" ? "success" : "failure"), () => finishAttempt(attempt, "failure"));
        };
        scheduleNext();
        return {
            result,
            cancel: () => settle({ status: "cancelled" }),
        };
    }
}
exports.Allocator = Allocator;
