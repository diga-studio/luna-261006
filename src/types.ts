/** 服务名 */
export type ServiceName = string;

/** 单个构建步骤 */
export interface StepSpec {
  /** 步骤名（用于状态展示） */
  name: string;
  /** 可执行命令 */
  command: string;
  /** 命令参数 */
  args?: string[];
  /** 工作目录（可选） */
  cwd?: string;
  /** 附加环境变量（可选） */
  env?: Record<string, string>;
}

/** 服务定义：有序步骤列表 */
export interface ServiceSpec {
  name: ServiceName;
  /** 该服务依赖的服务（必须先在本次或既有成果中成功） */
  dependencies: ServiceName[];
  /** 有序构建步骤 */
  steps: StepSpec[];
}

/** 提交一条流水线所需的输入 */
export interface PipelineSpec {
  /** 全部服务定义（含无环依赖图） */
  services: ServiceSpec[];
  /** 本次变更的服务集合 */
  changed: ServiceName[];
  /** 并发执行名额（同时运行的构建进程数上限） */
  maxParallel: number;
  /** 单步骤时限（毫秒），从步骤启动起算 */
  stepTimeoutMs: number;
  /** 流水线总时限（毫秒），从提交起算，含排队时间 */
  pipelineTimeoutMs: number;
}

export type StepState = "pending" | "running" | "succeeded" | "failed" | "timed_out" | "skipped";

export type ServiceState = "pending" | "running" | "succeeded" | "failed" | "blocked";

export type PipelineResult = "success" | "failure" | "timeout";

export type PipelinePhase = "running" | "completed";

export interface StepStatus {
  name: string;
  state: StepState;
  exitCode: number | null;
}

export interface ServiceStatus {
  name: ServiceName;
  state: ServiceState;
  steps: StepStatus[];
}

export interface PipelineStatus {
  id: string;
  phase: PipelinePhase;
  /** 仅当 phase === "completed" 时有值 */
  result: PipelineResult | null;
  services: Record<ServiceName, ServiceStatus>;
}

export interface PipelineHandle {
  readonly id: string;
  /** 查询当前状态（快照） */
  status(): PipelineStatus;
  /** 等待最终结果（所有选中服务有终态且所有构建进程已退出） */
  wait(): Promise<PipelineStatus>;
}
