export type JpegPrivacyErrorCode =
  | "INVALID_JPEG"
  | "UNSUPPORTED_JPEG"
  | "INVALID_EXIF"
  | "CONFLICTING_EXIF";

export class JpegPrivacyError extends Error {
  readonly code: JpegPrivacyErrorCode;

  constructor(code: JpegPrivacyErrorCode, message: string) {
    super(message);
    this.name = "JpegPrivacyError";
    this.code = code;
  }
}
