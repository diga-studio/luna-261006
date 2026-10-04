/** 导入任务句柄信息（持久化在 tasks 表）。 */
export interface ImportProgress {
  /** 已完成（已提交）的逻辑记录数 */
  completed: number;
  /** 成功记录数 */
  succeeded: number;
  /** 失败记录数 */
  failed: number;
  /** 是否已到达文件末尾 */
  done: boolean;
}

/** 单条记录的逐行结果。 */
export interface RecordResult {
  /** 记录号，从 1 开始，不含表头 */
  recordNo: number;
  /** 该记录是否成功 */
  ok: boolean;
  /** 记录中的 external_id（原始解码值） */
  externalId: string;
  /** 成功时本行产生的 revision */
  revision: number | null;
  /** 失败原因（成功时为 null） */
  error: string | null;
}

export interface InspectResult extends ImportProgress {
  /** recordNo > after 的至多 limit 条结果，按记录号升序 */
  results: RecordResult[];
}

export interface AdvanceResult extends ImportProgress {
  /** 本次推进处理的记录数 */
  processed: number;
}

export interface HrCase {
  externalId: string;
  category: string;
  description: string;
  revision: number;
}

/** 四个公开操作。 */
export interface Importer {
  createImport(path: string): number;
  advanceImport(id: number): AdvanceResult;
  inspectImport(id: number, after: number, limit: number): InspectResult;
  getCase(externalId: string): HrCase | null;
  close(): void;
}
