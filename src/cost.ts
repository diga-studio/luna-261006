import { createHash } from "node:crypto";

/**
 * 单题随机成本：对 JSON.stringify([seed, questionId]) 的 UTF-8 编码做 SHA-256，
 * 取摘要前 4 字节对应的大端无符号整数。
 */
export function questionCost(seed: string, questionId: string): number {
  const digest = createHash("sha256")
    .update(JSON.stringify([seed, questionId]), "utf8")
    .digest();
  return digest.readUInt32BE(0);
}
