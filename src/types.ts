/** 发布请求。requestId 全局唯一，用于重试去重。 */
export interface PublishRequest {
  requestId: string;
  /** 调用方提供的完整本地输入目录，包含流水线 JSON 与模型文件。 */
  sourceDir: string;
}

/** 发布结果。 */
export interface PublishResult {
  requestId: string;
  /** 是否为相同请求标识的重复提交（返回首次处理结果）。 */
  duplicate: boolean;
  releaseId: number;
  /** 本次发布切换后的运行代次。 */
  generation: number;
}

/** 推理结果报告。 */
export interface ReportRequest {
  requestId: string;
  /** 产生该结果的运行代次。 */
  generation: number;
  /** 毫秒时间戳。同一代次内不递减。 */
  timestamp: number;
  success: boolean;
}

/** 一次自动回退的描述。 */
export interface RollbackInfo {
  /** 被淘汰的发布。 */
  eliminatedReleaseId: number;
  /** 回退目标发布；无候选时为 null（停止运行）。 */
  targetReleaseId: number | null;
  /** 回退后的新运行代次。 */
  generation: number;
}

/** 报告处理结果。 */
export interface ReportResult {
  requestId: string;
  duplicate: boolean;
  /** 报告是否被接受（旧代次报告被忽略）。 */
  accepted: boolean;
  /** 本次报告触发的自动回退；未触发为 null。 */
  rollback: RollbackInfo | null;
}

/** 一条发布记录。 */
export interface ReleaseInfo {
  releaseId: number;
  /** 是否已被自动回退淘汰。 */
  eliminated: boolean;
  createdAt: number;
}

/** 网关当前状态（恢复 / 查看共用）。 */
export interface GatewayStatus {
  /** 当前运行代次；从未发布过为 0。 */
  generation: number;
  /** 当前生效发布；停止运行或从未发布为 null。 */
  currentReleaseId: number | null;
  /** 是否有正在运行的包。 */
  running: boolean;
  /** 全部发布历史（含已淘汰），按发布时间升序。 */
  releases: ReleaseInfo[];
}
