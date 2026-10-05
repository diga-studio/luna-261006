/** 所有预览/导出失败都抛出此错误，绝不返回原图或部分净化结果。 */
export class JpegPrivacyError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "JpegPrivacyError";
    this.code = code;
  }
}
