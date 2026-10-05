/** 可信帧清单：由上层在任务登记完成前提供。 */
export interface TrustedManifest {
  /** 画面宽度（像素）。 */
  width: number;
  /** 画面高度（像素）。 */
  height: number;
  /** 帧率，仅允许 12、24、30。 */
  frameRate: 12 | 24 | 30;
  /** 时长（秒），5 至 30 的 5 秒倍数。 */
  durationSeconds: number;
  /** 按展示顺序排列的帧 SHA-256（十六进制小写，64 字符）。 */
  frameSha256: string[];
}

/** 核验失败原因码。 */
export type VerifyErrorCode =
  | 'INVALID_MANIFEST'
  | 'IO_ERROR'
  | 'NOT_MP4'
  | 'BOX_STRUCTURE'
  | 'TRACK_LAYOUT'
  | 'SAMPLE_TABLE'
  | 'SAMPLE_RANGE'
  | 'TIMELINE'
  | 'DURATION_MISMATCH'
  | 'DIMENSION_MISMATCH'
  | 'FRAME_COUNT_MISMATCH'
  | 'HASH_MISMATCH';

export interface VerifyError {
  code: VerifyErrorCode;
  message: string;
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; error: VerifyError };

export interface VerifyOptions {
  /** 元数据（moov 等）允许的最大字节数，默认 1 MiB。 */
  maxMetadataBytes?: number;
}
