import { readFile, stat } from 'node:fs/promises';
import { MAX_ARCHIVE_BYTES, MAX_TOTAL_UNCOMPRESSED_BYTES } from './constants';
import { crc32 } from './crc32';
import { inflateRawLimited } from './inflate';
import { hasBannedExtension } from './nameCheck';
import { InspectionResult, Verdict } from './types';
import { parseZip } from './zipReader';

const METHOD_STORED = 0;

function review(reason: string): InspectionResult {
  return { verdict: 'review', reason };
}

/** 详细检查：返回结论与原因。 */
export async function inspectZipDetailed(filePath: string): Promise<InspectionResult> {
  let buf: Buffer;
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return review('not a regular file');
    if (info.size > MAX_ARCHIVE_BYTES) return review('archive exceeds 100 MiB input limit');
    buf = await readFile(filePath);
  } catch (err) {
    return review(`cannot read file: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (buf.length > MAX_ARCHIVE_BYTES) return review('archive exceeds 100 MiB input limit');

  // 结构验证：任何异常都优先于扩展名命中，一律复核
  const parsed = parseZip(buf);
  if (!parsed.ok) return review(parsed.reason);

  // 数据验证：实际展开长度、压缩数据长度、CRC-32 必须与声明一致
  let totalUncompressed = 0;
  for (const member of parsed.members) {
    const data = buf.subarray(member.dataOffset, member.dataOffset + member.dataLength);
    let actual: Buffer;
    if (member.central.method === METHOD_STORED) {
      actual = data;
      if (totalUncompressed + actual.length > MAX_TOTAL_UNCOMPRESSED_BYTES) {
        return review('total uncompressed size exceeds 128 MiB limit');
      }
    } else {
      const remaining = MAX_TOTAL_UNCOMPRESSED_BYTES - totalUncompressed;
      const declared = member.central.uncompressedSize;
      const cap = Math.min(declared, remaining);
      const result = await inflateRawLimited(data, cap);
      if (!result.ok) {
        return review(
          result.reason === 'uncompressed size limit exceeded'
            ? declared <= remaining
              ? 'actual uncompressed size exceeds declared'
              : 'total uncompressed size exceeds 128 MiB limit'
            : result.reason,
        );
      }
      actual = result.output;
    }
    if (actual.length !== member.central.uncompressedSize) {
      return review('actual uncompressed size differs from declared');
    }
    totalUncompressed += actual.length;
    if (crc32(actual) !== member.central.crc) {
      return review('crc-32 mismatch');
    }
    if (member.isDirectory && actual.length !== 0) {
      return review('directory member has non-empty content');
    }
  }

  // 内容检查：禁用扩展名
  for (const member of parsed.members) {
    if (!member.isDirectory && hasBannedExtension(member.name)) {
      return { verdict: 'quarantine', reason: `banned extension in member name: ${member.name}` };
    }
  }
  return { verdict: 'allow', reason: 'ok' };
}

/** 对本地 ZIP 文件做入库检查，返回结论。文件保持原位，不解压落盘。 */
export async function inspectZip(filePath: string): Promise<Verdict> {
  const result = await inspectZipDetailed(filePath);
  return result.verdict;
}
