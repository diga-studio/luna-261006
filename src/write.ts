import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { DEMMeta } from "./types";

const ALLOWED_STEPS = new Set([0.5, 1, 5, 10]);

export function validateMeta(meta: DEMMeta): void {
  if (!meta || typeof meta !== "object") {
    throw new TypeError("meta must be an object");
  }
  if (!Number.isInteger(meta.width) || meta.width < 1) {
    throw new RangeError("meta.width must be a positive integer");
  }
  if (!Number.isInteger(meta.height) || meta.height < 1) {
    throw new RangeError("meta.height must be a positive integer");
  }
  if (!Number.isFinite(meta.x0) || !Number.isFinite(meta.y0)) {
    throw new RangeError("meta.x0 and meta.y0 must be finite numbers");
  }
  if (!ALLOWED_STEPS.has(meta.step)) {
    throw new RangeError("meta.step must be one of 0.5, 1, 5, 10 (meters)");
  }
}

function rowToLittleEndianBuffer(row: Float64Array): Buffer {
  if (os.endianness() === "LE") {
    return Buffer.from(row.buffer, row.byteOffset, row.byteLength);
  }
  const buf = Buffer.allocUnsafe(row.length * 8);
  for (let i = 0; i < row.length; i++) {
    buf.writeDoubleLE(row[i], i * 8);
  }
  return buf;
}

/**
 * 将 DEM 写入本地目录：meta.json + elevation.bin（小端 Float64，按行排列）。
 * rows 为异步行流，每行是长度为 meta.width 的 Float64Array，共 meta.height 行。
 * 行按 y 增大方向排列，行内节点沿 x 增大方向排列；NaN 表示 NoData。
 */
export async function writeDEM(
  directory: string,
  meta: DEMMeta,
  rows: AsyncIterable<Float64Array>,
): Promise<void> {
  validateMeta(meta);
  await fs.promises.mkdir(directory, { recursive: true });

  const binPath = path.join(directory, "elevation.bin");
  const stream = fs.createWriteStream(binPath);
  let rowCount = 0;
  try {
    for await (const row of rows) {
      if (!(row instanceof Float64Array)) {
        throw new TypeError(`row ${rowCount} is not a Float64Array`);
      }
      if (row.length !== meta.width) {
        throw new RangeError(
          `row ${rowCount} has length ${row.length}, expected ${meta.width}`,
        );
      }
      if (rowCount >= meta.height) {
        throw new RangeError(`more than meta.height (${meta.height}) rows supplied`);
      }
      const buf = rowToLittleEndianBuffer(row);
      if (!stream.write(buf)) {
        await new Promise<void>((resolve, reject) => {
          stream.once("drain", resolve);
          stream.once("error", reject);
        });
      }
      rowCount++;
    }
  } catch (err) {
    stream.destroy();
    throw err;
  }
  await new Promise<void>((resolve, reject) => {
    stream.end((err?: Error | null) => (err ? reject(err) : resolve()));
  });
  if (rowCount !== meta.height) {
    throw new RangeError(
      `expected meta.height (${meta.height}) rows, received ${rowCount}`,
    );
  }

  const metaJson = {
    width: meta.width,
    height: meta.height,
    x0: meta.x0,
    y0: meta.y0,
    step: meta.step,
  };
  await fs.promises.writeFile(
    path.join(directory, "meta.json"),
    JSON.stringify(metaJson, null, 2) + "\n",
    "utf8",
  );
}
