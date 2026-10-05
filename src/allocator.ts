import type {
  Executor,
  OccupancyEntry,
  RequestHandle,
  RequestResult,
  TargetConfig,
} from "./types.js";

/** 单次尝试的等待期限（毫秒）。 */
export const ATTEMPT_TIMEOUT_MS = 3000;
/** 第一次重试前的等待（毫秒）。 */
export const FIRST_RETRY_DELAY_MS = 200;
/** 第二次重试前的等待（毫秒）。 */
export const SECOND_RETRY_DELAY_MS = 400;
/** 每个请求的最大尝试次数。 */
export const MAX_ATTEMPTS = 3;

/** 可选的时间参数覆盖（主要用于测试），缺省使用常量默认值。 */
export interface AllocatorOptions {
  readonly attemptTimeoutMs?: number;
  readonly retryDelaysMs?: readonly number[];
  readonly maxAttempts?: number;
}

interface MutableSignal {
  cancelled: boolean;
}

interface Attempt {
  readonly targetId: string;
  readonly signal: MutableSignal;
  /** 执行器是否已真正结束（占用仅在此时释放）。 */
  finished: boolean;
  /** 是否已超时（超时后迟到的结果只释放占用）。 */
  timedOut: boolean;
  timeoutTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * TrafficForge 请求分配器：单后端池，配置与运行状态均保存在进程内。
 */
export class Allocator {
  private readonly executor: Executor;
  private readonly attemptTimeoutMs: number;
  private readonly retryDelaysMs: readonly number[];
  private readonly maxAttempts: number;

  /** 当前配置：targetId -> maxConcurrency。 */
  private config = new Map<string, number>();
  /** 占用：targetId -> 进行中的尝试数（含已移除目标的残留占用）。 */
  private inFlight = new Map<string, number>();

  constructor(executor: Executor, options: AllocatorOptions = {}) {
    this.executor = executor;
    this.attemptTimeoutMs = options.attemptTimeoutMs ?? ATTEMPT_TIMEOUT_MS;
    this.retryDelaysMs = options.retryDelaysMs ?? [
      FIRST_RETRY_DELAY_MS,
      SECOND_RETRY_DELAY_MS,
    ];
    this.maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
  }

  /** 整体替换目标配置。 */
  replaceConfig(targets: readonly TargetConfig[]): void {
    const next = new Map<string, number>();
    for (const target of targets) {
      if (next.has(target.id)) {
        throw new Error(`duplicate target id: ${target.id}`);
      }
      if (
        !Number.isInteger(target.maxConcurrency) ||
        target.maxConcurrency < 1
      ) {
        throw new Error(
          `invalid maxConcurrency for target ${target.id}: ${target.maxConcurrency}`,
        );
      }
      next.set(target.id, target.maxConcurrency);
    }
    this.config = next;
  }

  /** 查询当前占用（含已移除但仍有占用的目标）。 */
  occupancy(): readonly OccupancyEntry[] {
    const ids = new Set<string>([...this.config.keys(), ...this.inFlight.keys()]);
    const entries: OccupancyEntry[] = [];
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
  submit(): RequestHandle {
    const triedTargetIds = new Set<string>();
    const liveAttempts = new Set<Attempt>();
    let settled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attemptsUsed = 0;
    let resolveResult!: (result: RequestResult) => void;

    const result = new Promise<RequestResult>((resolve) => {
      resolveResult = resolve;
    });

    const settle = (final: RequestResult): void => {
      if (settled) return;
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

    const releaseOccupancy = (targetId: string): void => {
      const current = this.inFlight.get(targetId);
      if (current === undefined) return;
      if (current <= 1) {
        this.inFlight.delete(targetId);
      } else {
        this.inFlight.set(targetId, current - 1);
      }
    };

    const pickTarget = (): string | null => {
      let best: string | null = null;
      let bestLoad = Infinity;
      for (const [id, max] of this.config) {
        if (triedTargetIds.has(id)) continue;
        const load = this.inFlight.get(id) ?? 0;
        if (load >= max) continue;
        if (load < bestLoad || (load === bestLoad && (best === null || id < best))) {
          best = id;
          bestLoad = load;
        }
      }
      return best;
    };

    const finishAttempt = (attempt: Attempt, outcome: "success" | "failure"): void => {
      if (attempt.finished) return;
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

    const scheduleNext = (): void => {
      if (settled) return;
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

    const startAttempt = (): void => {
      if (settled) return;
      const targetId = pickTarget();
      if (targetId === null) {
        settle({ status: "no-available-target" });
        return;
      }
      triedTargetIds.add(targetId);
      attemptsUsed += 1;
      this.inFlight.set(targetId, (this.inFlight.get(targetId) ?? 0) + 1);

      const attempt: Attempt = {
        targetId,
        signal: { cancelled: false },
        finished: false,
        timedOut: false,
        timeoutTimer: null,
      };
      liveAttempts.add(attempt);

      attempt.timeoutTimer = setTimeout(() => {
        attempt.timeoutTimer = null;
        if (attempt.finished) return;
        attempt.timedOut = true;
        attempt.signal.cancelled = true;
        // 占用不释放，等执行器真正结束；但可立即进入重试等待。
        scheduleNext();
      }, this.attemptTimeoutMs);

      let outcomePromise: Promise<"success" | "failure">;
      try {
        outcomePromise = Promise.resolve(this.executor(targetId, attempt.signal));
      } catch {
        outcomePromise = Promise.resolve("failure");
      }
      outcomePromise.then(
        (outcome) => finishAttempt(attempt, outcome === "success" ? "success" : "failure"),
        () => finishAttempt(attempt, "failure"),
      );
    };

    scheduleNext();

    return {
      result,
      cancel: () => settle({ status: "cancelled" }),
    };
  }
}
