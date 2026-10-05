import type { Executor, OccupancyEntry, RequestHandle, TargetConfig } from "./types.js";
/** 单次尝试的等待期限（毫秒）。 */
export declare const ATTEMPT_TIMEOUT_MS = 3000;
/** 第一次重试前的等待（毫秒）。 */
export declare const FIRST_RETRY_DELAY_MS = 200;
/** 第二次重试前的等待（毫秒）。 */
export declare const SECOND_RETRY_DELAY_MS = 400;
/** 每个请求的最大尝试次数。 */
export declare const MAX_ATTEMPTS = 3;
/** 可选的时间参数覆盖（主要用于测试），缺省使用常量默认值。 */
export interface AllocatorOptions {
    readonly attemptTimeoutMs?: number;
    readonly retryDelaysMs?: readonly number[];
    readonly maxAttempts?: number;
}
/**
 * TrafficForge 请求分配器：单后端池，配置与运行状态均保存在进程内。
 */
export declare class Allocator {
    private readonly executor;
    private readonly attemptTimeoutMs;
    private readonly retryDelaysMs;
    private readonly maxAttempts;
    /** 当前配置：targetId -> maxConcurrency。 */
    private config;
    /** 占用：targetId -> 进行中的尝试数（含已移除目标的残留占用）。 */
    private inFlight;
    constructor(executor: Executor, options?: AllocatorOptions);
    /** 整体替换目标配置。 */
    replaceConfig(targets: readonly TargetConfig[]): void;
    /** 查询当前占用（含已移除但仍有占用的目标）。 */
    occupancy(): readonly OccupancyEntry[];
    /** 提交一个可取消的请求。 */
    submit(): RequestHandle;
}
