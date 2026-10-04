import { createInflateRaw } from 'node:zlib';
import { crc32 } from './crc32.ts';
import { METHOD_STORE } from './types.ts';

export interface MemberDataResult {
  ok: boolean;
  reason?:
    | 'deflate-invalid'
    | 'deflate-trailing-bytes'
    | 'deflate-truncated'
    | 'expanded-size-limit-exceeded'
    | 'size-crc-mismatch';
  /** 实际展开字节数（超限时为停止时刻的计数） */
  actualSize: number;
  actualCrc: number;
}

/**
 * 校验成员压缩数据。
 * - method 0（不压缩）：数据即内容。
 * - method 8（Deflate）：流式展开，要求流完整结束且恰好消费全部声明的压缩字节，
 *   声明范围内不能夹带未消费的尾部字节。
 * 展开过程中实时累计字节数与 CRC-32；一旦累计展开量超过 remainingBudget 立即停止。
 */
export function verifyMemberData(
  data: Buffer,
  method: number,
  expectedSize: number,
  expectedCrc: number,
  remainingBudget: number,
): Promise<MemberDataResult> {
  if (method === METHOD_STORE) {
    const actualCrc = crc32(data);
    const actualSize = data.length;
    if (actualSize > remainingBudget) {
      return Promise.resolve({
        ok: false,
        reason: 'expanded-size-limit-exceeded',
        actualSize,
        actualCrc,
      });
    }
    if (actualSize !== expectedSize || actualCrc !== expectedCrc) {
      return Promise.resolve({ ok: false, reason: 'size-crc-mismatch', actualSize, actualCrc });
    }
    return Promise.resolve({ ok: true, actualSize, actualCrc });
  }

  return new Promise<MemberDataResult>((resolve) => {
    const inflater = createInflateRaw();
    let actualSize = 0;
    let actualCrc = 0;
    let exceeded = false;
    let ended = false;
    let settled = false;

    const done = (result: MemberDataResult) => {
      if (!settled) {
        settled = true;
        inflater.destroy();
        resolve(result);
      }
    };

    inflater.on('data', (chunk: Buffer) => {
      if (settled) return;
      actualSize += chunk.length;
      actualCrc = crc32(chunk, actualCrc);
      if (actualSize > remainingBudget) {
        exceeded = true;
        done({
          ok: false,
          reason: 'expanded-size-limit-exceeded',
          actualSize,
          actualCrc,
        });
      }
    });

    inflater.on('error', () => {
      if (exceeded || settled) return;
      done({ ok: false, reason: 'deflate-invalid', actualSize, actualCrc });
    });

    inflater.on('end', () => {
      if (settled) return;
      ended = true;
      if (inflater.bytesWritten !== data.length) {
        // 流已结束但声明的压缩数据范围内还有未被消费的字节
        done({ ok: false, reason: 'deflate-trailing-bytes', actualSize, actualCrc });
        return;
      }
      if (actualSize !== expectedSize || actualCrc !== expectedCrc) {
        done({ ok: false, reason: 'size-crc-mismatch', actualSize, actualCrc });
        return;
      }
      done({ ok: true, actualSize, actualCrc });
    });

    inflater.on('close', () => {
      // 输入耗尽而流未正常结束（且非超限主动停止）
      if (!settled && !ended) {
        done({ ok: false, reason: 'deflate-truncated', actualSize, actualCrc });
      }
    });

    inflater.end(data);
  });
}
