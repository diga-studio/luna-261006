/** 检查结论 */
export type Verdict = 'allow' | 'quarantine' | 'review';

/** 结构异常等原因码（用于复核/隔离的可读说明） */
export type ReasonCode =
  | 'file-too-large'
  | 'file-unreadable'
  | 'not-a-zip'
  | 'eocd-invalid'
  | 'zip64'
  | 'multi-volume'
  | 'central-directory-invalid'
  | 'local-header-invalid'
  | 'record-overlap'
  | 'unaccounted-bytes'
  | 'local-central-mismatch'
  | 'shared-local-record'
  | 'encrypted'
  | 'unsupported-compression'
  | 'unsupported-flags'
  | 'non-ascii-name'
  | 'unicode-path-extra'
  | 'extra-field-truncated'
  | 'data-descriptor-invalid'
  | 'descriptor-mismatch'
  | 'size-crc-mismatch'
  | 'deflate-invalid'
  | 'deflate-trailing-bytes'
  | 'deflate-truncated'
  | 'directory-not-empty'
  | 'expanded-size-limit-exceeded'
  | 'banned-extension';

export interface CheckResult {
  verdict: Verdict;
  reasons: ReasonCode[];
  /** 命中的禁用扩展名（小写，含点），仅隔离时有值 */
  bannedHits: { name: string; extension: string }[];
}

/** 压缩方式 */
export const METHOD_STORE = 0;
export const METHOD_DEFLATE = 8;

/** 单包输入上限 100 MiB */
export const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
/** 累计实际展开量上限 128 MiB */
export const MAX_TOTAL_EXPANDED_BYTES = 128 * 1024 * 1024;
