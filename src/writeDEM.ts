import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { endianness } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { ALLOWED_STEPS, type DEMMeta } from './types';

function validateMeta(meta: DEMMeta): void {
  if (!meta || typeof meta !== 'object') {
    throw new TypeError('meta is required');
  }
  if (!Number.isInteger(meta.width) || meta.width < 1) {
    throw new RangeError('meta.width must be a positive integer (node count)');
  }
  if (!Number.isInteger(meta.height) || meta.height < 1) {
    throw new RangeError('meta.height must be a positive integer (node count)');
  }
  if (!Number.isFinite(meta.x0) || !Number.isFinite(meta.y0)) {
    throw new RangeError('meta.x0 and meta.y0 must be finite numbers');
  }
  if (!ALLOWED_STEPS.includes(meta.step)) {
    throw new RangeError('meta.step must be one of 0.5, 1, 5, 10 (meters)');
  }
}

/**
 * 将 DEM 写入本地目录：meta.json + elevation.bin（小端 Float64，按行排列，
 * 行沿 y 增大方向、列沿 x 增大方向）。rows 为异步行流，每行是长度为
 * meta.width 的 Float64Array，必须恰好提供 meta.height 行。
 */
export async function writeDEM(
  directory: string,
  meta: DEMMeta,
  rows: AsyncIterable<Float64Array>,
): Promise<void> {
  validateMeta(meta);
  await mkdir(directory, { recursive: true });

  const binPath = join(directory, 'elevation.bin');
  const stream = createWriteStream(binPath);
  const littleEndianHost = endianness() === 'LE';
  let rowCount = 0;
  let failure: unknown;

  try {
    for await (const row of rows) {
      if (!(row instanceof Float64Array)) {
        throw new TypeError('each row must be a Float64Array');
      }
      if (row.length !== meta.width) {
        throw new RangeError(
          `row ${rowCount} has length ${row.length}, expected ${meta.width}`,
        );
      }
      if (rowCount >= meta.height) {
        throw new RangeError(`more than meta.height (${meta.height}) rows provided`);
      }
      const buf = Buffer.from(row.buffer, row.byteOffset, row.byteLength);
      if (!littleEndianHost) buf.swap64();
      if (!stream.write(buf)) {
        await once(stream, 'drain');
      }
      rowCount += 1;
    }
    if (rowCount !== meta.height) {
      throw new RangeError(
        `expected ${meta.height} rows, received ${rowCount}`,
      );
    }
  } catch (err) {
    failure = err;
    stream.destroy();
  }

  if (failure !== undefined) throw failure;

  stream.end();
  await once(stream, 'finish');

  // meta.json 最后写入：存在完整的 meta.json 即表示 elevation.bin 已写完。
  await writeFile(join(directory, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
}
