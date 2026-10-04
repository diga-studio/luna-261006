import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { writeDEM } from "../src/index";
import type { DEMMeta } from "../src/index";

/** 用二维数组（rows[y][x]）通过 writeDEM 落盘一份 DEM，返回目录路径。 */
export async function writeTestDEM(
  meta: DEMMeta,
  values: number[][],
): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "dem-test-"));
  async function* rows(): AsyncGenerator<Float64Array> {
    for (const row of values) {
      yield Float64Array.from(row);
    }
  }
  await writeDEM(dir, meta, rows());
  return dir;
}

/** 断言实际值与期望值接近（默认绝对容差 1e-9）。 */
export function assertClose(
  actual: number,
  expected: number,
  tol = 1e-9,
  message?: string,
): void {
  const diff = Math.abs(actual - expected);
  if (!(diff <= tol)) {
    throw new Error(
      `${message ?? "assertClose"}: |${actual} - ${expected}| = ${diff} > ${tol}`,
    );
  }
}

export const CUBIC_METERS_PER_CUBIC_YARD = 0.9144 ** 3;
