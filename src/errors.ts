/** 核验失败原因码，便于上层分类处理。 */
export type VerifyErrorCode =
  | 'IO'
  | 'BOX_STRUCTURE'
  | 'UNSUPPORTED'
  | 'TRACK_LAYOUT'
  | 'SAMPLE_TABLE'
  | 'TIMELINE'
  | 'DURATION_MISMATCH'
  | 'GEOMETRY_MISMATCH'
  | 'FRAME_COUNT_MISMATCH'
  | 'HASH_MISMATCH'
  | 'BAD_MANIFEST';

export class VerifyError extends Error {
  readonly code: VerifyErrorCode;
  constructor(code: VerifyErrorCode, message: string) {
    super(message);
    this.name = 'VerifyError';
    this.code = code;
  }
}
