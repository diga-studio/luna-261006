/** 推理结果报告。 */
export interface InferenceReport {
  /** 产生该报告时网关运行的代次。 */
  generation: number;
  /** 报告时间，毫秒。同一代次内不递减。 */
  timestampMs: number;
  /** 推理是否成功。 */
  success: boolean;
}

/** 发布结果。 */
export interface PublishResult {
  requestId: string;
  /** 新发布的发布记录 ID。 */
  releaseId: number;
  /** 切换到该发布后的运行代次。 */
  generation: number;
  /** 是否为重复请求（返回首次处理结果）。 */
  duplicated: boolean;
}

/** 报告处理结果。 */
export interface ReportResult {
  requestId: string;
  /** 报告是否作用于当前运行代次（旧代次报告为 false）。 */
  applied: boolean;
  /** 本次报告是否触发了自动回退。 */
  rolledBack: boolean;
  /** 是否为重复请求。 */
  duplicated: boolean;
}

/** 单条发布记录信息。 */
export interface ReleaseInfo {
  id: number;
  createdAtMs: number;
  eliminated: boolean;
}

/** 网关当前状态。 */
export interface GatewayStatus {
  /** 当前是否有运行中的发布包。 */
  running: boolean;
  /** 当前运行代次；停止时为最近一次使用的代次（初始为 0）。 */
  generation: number;
  /** 当前运行的发布 ID；停止时为 null。 */
  currentReleaseId: number | null;
  /** 当前运行包的本地目录；停止时为 null。 */
  activeDir: string | null;
  /** 全部发布历史（按发布时间升序）。 */
  releases: ReleaseInfo[];
}

/** 崩溃注入钩子：在关键持久化边界被调用，测试可借此模拟进程退出。 */
export type CrashHook = (point: string) => void;

export interface GatewayManagerOptions {
  crashHook?: CrashHook;
}
