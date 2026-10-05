/** 可信凭据：由调用方另行保管，不包含任何业务原文。 */
export interface Credential {
  /** 凭据格式版本。 */
  version: 1;
  /** 已应用的操作总数（追加 + 有效擦除）。 */
  opCount: number;
  /** 已分配的最大记录序号。 */
  recordCount: number;
  /** 操作日志哈希链在 opCount 处的链头。 */
  stateHash: string;
}

export interface AppendResult {
  /** 账本分配的不可复用递增序号。 */
  seq: number;
  credential: Credential;
}

export interface EraseResult {
  /** 本次擦除的存活记录数；0 表示账本与凭据均未改变。 */
  erased: number;
  credential: Credential;
}

export interface VerifyOk {
  ok: true;
}

export interface VerifyFail {
  ok: false;
  reason: string;
}

export type VerifyResult = VerifyOk | VerifyFail;

/** 存活记录视图（用于调用方读取/测试核对）。 */
export interface LiveRecord {
  seq: number;
  subject: string;
  body: unknown;
}
