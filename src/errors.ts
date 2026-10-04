export type Mp3ProbeErrorCode =
  | 'ID3V2_INVALID'
  | 'ID3V2_FOOTER_MISMATCH'
  | 'FRAME_HEADER_INVALID'
  | 'FRAME_TRUNCATED'
  | 'INCONSISTENT_STREAM'
  | 'XING_INVALID'
  | 'XING_COUNT_MISMATCH'
  | 'NO_AUDIO_FRAMES'
  | 'NEGATIVE_PLAYABLE'
  | 'TRAILING_GARBAGE'
  | 'ID3V1_INVALID'
  | 'UNEXPECTED_DATA_AFTER_ID3V1';

export class Mp3ProbeError extends Error {
  readonly code: Mp3ProbeErrorCode;
  constructor(code: Mp3ProbeErrorCode, message: string) {
    super(message);
    this.name = 'Mp3ProbeError';
    this.code = code;
  }
}
