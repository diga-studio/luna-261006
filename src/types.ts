/** 可信帧清单：由上层在任务登记完成前提供。 */
export interface TrustedManifest {
  /** 画面宽度（像素），须与 avc1 描述一致。 */
  width: number;
  /** 画面高度（像素），须与 avc1 描述一致。 */
  height: number;
  /** 帧率，仅允许 12、24、30。 */
  frameRate: number;
  /** 时长（秒），5 至 30 的 5 秒倍数。 */
  durationSeconds: number;
  /** 按展示顺序排列的每帧 SHA-256（小写十六进制，64 字符）。 */
  frameSha256: string[];
}

/** 核验结果：通过时 ok 为 true；失败时抛出 VerifyError，不返回部分结果。 */
export interface VerifySuccess {
  ok: true;
  /** 核验的帧数。 */
  frameCount: number;
}
