export type Mp3ProbeErrorCode =
  | "ERR_ID3V2_HEADER"
  | "ERR_ID3V2_FOOTER"
  | "ERR_ID3V1"
  | "ERR_FRAME_HEADER"
  | "ERR_FRAME_TRUNCATED"
  | "ERR_INCONSISTENT_FORMAT"
  | "ERR_XING"
  | "ERR_XING_MISMATCH"
  | "ERR_NO_AUDIO"
  | "ERR_TRAILING_GARBAGE"
  | "ERR_UNEXPECTED_EOF"
  | "ERR_PUSH_AFTER_FINISH";

export class Mp3ProbeError extends Error {
  readonly code: Mp3ProbeErrorCode;
  constructor(code: Mp3ProbeErrorCode, message: string) {
    super(message);
    this.name = "Mp3ProbeError";
    this.code = code;
  }
}
