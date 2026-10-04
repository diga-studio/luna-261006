import { createInflateRaw } from 'node:zlib';

export type InflateResult =
  | { ok: true; output: Buffer }
  | { ok: false; reason: string };

/**
 * 流式展开 raw Deflate 数据。
 * 输出一旦超过 maxOutput 立即失败并停止展开；流必须完整结束，
 * 且输入中不得残留未被消费的尾部字节。
 */
export function inflateRawLimited(data: Buffer, maxOutput: number): Promise<InflateResult> {
  return new Promise((resolve) => {
    const stream = createInflateRaw();
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const done = (result: InflateResult): void => {
      if (settled) return;
      settled = true;
      stream.destroy();
      resolve(result);
    };

    stream.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxOutput) {
        done({ ok: false, reason: 'uncompressed size limit exceeded' });
        return;
      }
      chunks.push(chunk);
    });
    stream.on('error', (err: Error) => {
      done({ ok: false, reason: `deflate stream error: ${err.message}` });
    });
    stream.on('end', () => {
      if (stream.bytesWritten !== data.length) {
        done({ ok: false, reason: 'trailing bytes inside declared compressed data' });
        return;
      }
      done({ ok: true, output: Buffer.concat(chunks) });
    });
    stream.on('close', () => {
      done({ ok: false, reason: 'deflate stream closed before completion' });
    });

    stream.end(data);
  });
}
