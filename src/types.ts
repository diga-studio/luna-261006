/** 可信凭据：由调用方另行保管，不包含任何业务原文。 */
export interface Credential {
  /** 账本实例标识，防止跨账本混用凭据。 */
  ledgerId: string;
  /** 凭据覆盖的链式日志条目数（前缀长度）。 */
  length: number;
  /** 该前缀末尾的链头哈希（hex）。 */
  headHash: string;
}

/** 追加结果。 */
export interface AppendResult {
  seq: number;
  credential: Credential;
}

/** 擦除结果。 */
export interface EraseResult {
  /** 是否发生了实际擦除；无匹配存活记录时为 false，账本与凭据不变。 */
  erased: boolean;
  /** 被擦除的记录序号。 */
  erasedSeqs: number[];
  credential: Credential;
}

/** 一条存活业务记录的视图。 */
export interface RecordView {
  seq: number;
  subject: string;
  body: unknown;
}

/** 核验结果。 */
export interface VerifyResult {
  ok: boolean;
  /** 失败原因；成功时为 null。 */
  reason: string | null;
}
