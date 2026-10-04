import { readFile, stat } from 'node:fs/promises';
import type { CheckResult, ReasonCode } from './types.ts';
import { MAX_ARCHIVE_BYTES, MAX_TOTAL_EXPANDED_BYTES } from './types.ts';
import { parseZipStructure } from './zipStructure.ts';
import { verifyMemberData } from './inflate.ts';
import { findBannedExtension } from './nameRules.ts';

const review = (reasons: ReasonCode[]): CheckResult => ({
  verdict: 'review',
  reasons,
  bannedHits: [],
});

/**
 * 对本地 ZIP 文件执行入库检查。文件保留在原位置，不解压落盘，结果不持久化。
 * 结论：放行 allow / 隔离 quarantine / 人工复核 review。
 * 无法完整验证的归档一律复核；完整验证后存在禁用扩展名则隔离，否则放行。
 */
export async function checkZipFile(filePath: string): Promise<CheckResult> {
  let size: number;
  try {
    size = (await stat(filePath)).size;
  } catch {
    return review(['file-unreadable']);
  }
  if (size > MAX_ARCHIVE_BYTES) return review(['file-too-large']);

  let buf: Buffer;
  try {
    buf = await readFile(filePath);
  } catch {
    return review(['file-unreadable']);
  }

  // 第一层：结构完整性（EOCD / 中央目录 / 本地记录一一对应 / 无缝覆盖）
  const parsed = parseZipStructure(buf);
  if (!parsed.ok) return review(parsed.reasons);

  // 第二层：逐成员验证实际展开长度、压缩长度与 CRC-32，累计展开量超限即停
  let usedBudget = 0;
  for (const member of parsed.structure.members) {
    const data = buf.subarray(member.dataOffset, member.dataOffset + member.compressedSize);
    const result = await verifyMemberData(
      data,
      member.method,
      member.uncompressedSize,
      member.crc,
      MAX_TOTAL_EXPANDED_BYTES - usedBudget,
    );
    if (!result.ok) {
      return review([result.reason ?? 'size-crc-mismatch']);
    }
    if (member.isDirectory && result.actualSize !== 0) {
      return review(['directory-not-empty']);
    }
    usedBudget += result.actualSize;
  }

  // 第三层：完整验证通过后，检查非目录成员的禁用扩展名
  const bannedHits: { name: string; extension: string }[] = [];
  for (const member of parsed.structure.members) {
    if (member.isDirectory) continue;
    const ext = findBannedExtension(member.rawName);
    if (ext) bannedHits.push({ name: member.rawName.toString('utf8'), extension: ext });
  }
  if (bannedHits.length > 0) {
    return { verdict: 'quarantine', reasons: ['banned-extension'], bannedHits };
  }
  return { verdict: 'allow', reasons: [], bannedHits: [] };
}
