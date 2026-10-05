import type { TrustedManifest, VerifyOptions, VerifyResult } from './types.js';

/**
 * 核验本地 MP4 成片是否与可信帧清单一致。
 * 输入文件在核验期间保持不变。
 */
export async function verifyMp4(
  _filePath: string,
  _manifest: TrustedManifest,
  _options?: VerifyOptions
): Promise<VerifyResult> {
  throw new Error('not implemented');
}
