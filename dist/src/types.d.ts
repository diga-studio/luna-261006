/** 后端目标配置：标识稳定且唯一，附带并发上限。 */
export interface TargetConfig {
    /** 稳定且唯一的目标标识。 */
    readonly id: string;
    /** 该目标允许的最大并发占用数（>= 1）。 */
    readonly maxConcurrency: number;
}
/** 请求的最终结果。 */
export type RequestResult = {
    readonly status: "success";
} | {
    readonly status: "failure";
} | {
    readonly status: "cancelled";
} | {
    readonly status: "no-available-target";
};
/** 取消信号：由库发给上层执行器。 */
export interface CancelSignal {
    readonly cancelled: boolean;
}
/** 上层提供的进程内异步执行器。 */
export type Executor = (targetId: string, signal: CancelSignal) => Promise<"success" | "failure">;
/** 当前占用快照中单个目标的占用信息。 */
export interface OccupancyEntry {
    readonly targetId: string;
    /** 当前占用数（进行中的尝试数）。 */
    readonly inFlight: number;
    /** 若目标仍在当前配置中，给出其上限；已移除目标为 null。 */
    readonly maxConcurrency: number | null;
}
/** 请求句柄：promise 给出唯一最终结果，cancel 立即结束等待。 */
export interface RequestHandle {
    readonly result: Promise<RequestResult>;
    cancel(): void;
}
