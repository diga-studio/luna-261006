import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { integratePositivePartBilinear } from "./integrate";
import type { CompareResult, DEMMeta } from "./types";
import { validateMeta } from "./write";

/** 1 码 = 0.9144 米（严格定义），1 立方码 = 0.9144^3 立方米 */
const CUBIC_METERS_PER_CUBIC_YARD = 0.9144 * 0.9144 * 0.9144;

interface DEMData {
  meta: DEMMeta;
  /** 按行排列的节点高程：nodes[row * width + col]，NaN 表示 NoData */
  nodes: Float64Array;
  /** 单元有效性：cellValid[row * (width-1) + col]，四角均非 NoData 时有效 */
  cellValid: Uint8Array;
}

async function readDEM(directory: string): Promise<DEMData> {
  const metaRaw = await fs.promises.readFile(
    path.join(directory, "meta.json"),
    "utf8",
  );
  const meta = JSON.parse(metaRaw) as DEMMeta;
  validateMeta(meta);

  const bin = await fs.promises.readFile(path.join(directory, "elevation.bin"));
  const expectedBytes = meta.width * meta.height * 8;
  if (bin.byteLength !== expectedBytes) {
    throw new Error(
      `elevation.bin in ${directory} has ${bin.byteLength} bytes, expected ${expectedBytes}`,
    );
  }
  let nodes: Float64Array;
  if (os.endianness() === "LE") {
    nodes = new Float64Array(bin.buffer, bin.byteOffset, meta.width * meta.height);
  } else {
    nodes = new Float64Array(meta.width * meta.height);
    for (let i = 0; i < nodes.length; i++) {
      nodes[i] = bin.readDoubleLE(i * 8);
    }
  }

  const cellRows = Math.max(meta.height - 1, 0);
  const cellCols = Math.max(meta.width - 1, 0);
  const cellValid = new Uint8Array(cellRows * cellCols);
  for (let i = 0; i < cellRows; i++) {
    for (let j = 0; j < cellCols; j++) {
      const n00 = nodes[i * meta.width + j];
      const n10 = nodes[i * meta.width + j + 1];
      const n01 = nodes[(i + 1) * meta.width + j];
      const n11 = nodes[(i + 1) * meta.width + j + 1];
      cellValid[i * cellCols + j] =
        Number.isNaN(n00) || Number.isNaN(n10) || Number.isNaN(n01) || Number.isNaN(n11)
          ? 0
          : 1;
    }
  }
  return { meta, nodes, cellValid };
}

/** 单元 (i, j) 内双线性插值：x、y 必须落在该单元内。 */
function sampleCell(dem: DEMData, i: number, j: number, x: number, y: number): number {
  const { width, x0, y0, step } = dem.meta;
  const s = (x - (x0 + j * step)) / step;
  const t = (y - (y0 + i * step)) / step;
  const v00 = dem.nodes[i * width + j];
  const v10 = dem.nodes[i * width + j + 1];
  const v01 = dem.nodes[(i + 1) * width + j];
  const v11 = dem.nodes[(i + 1) * width + j + 1];
  return (
    v00 * (1 - s) * (1 - t) + v10 * s * (1 - t) + v01 * (1 - s) * t + v11 * s * t
  );
}

/** Kahan 补偿求和累加器，控制大量小项累加的舍入误差。 */
class KahanSum {
  private sum = 0;
  private compensation = 0;
  add(value: number): void {
    const y = value - this.compensation;
    const t = this.sum + y;
    this.compensation = t - this.sum - y;
    this.sum = t;
  }
  get value(): number {
    return this.sum;
  }
}

/**
 * 比较两份本地 DEM。
 *
 * 比较域 D 为两份 DEM 有效单元覆盖区域的交集。实现上把 D 分解为
 * 「旧有效单元 × 新有效单元」的矩形交集；每个交集矩形内两份 DEM 各自
 * 是双线性函数，其差仍是双线性函数，正部积分用闭式解精确求值。
 */
export async function compareDEMs(
  oldDirectory: string,
  newDirectory: string,
): Promise<CompareResult> {
  const oldDem = await readDEM(oldDirectory);
  const newDem = await readDEM(newDirectory);

  const om = oldDem.meta;
  const nm = newDem.meta;
  const oldCellRows = om.height - 1;
  const oldCellCols = om.width - 1;
  const newCellCols = nm.width - 1;

  const area = new KahanSum();
  const cut = new KahanSum();
  const fill = new KahanSum();

  for (let i = 0; i < oldCellRows; i++) {
    const oy0 = om.y0 + i * om.step;
    const oy1 = oy0 + om.step;
    // 与 [oy0, oy1] 有正面积交集的新单元行范围（零面积交集贡献为 0，含入无害）
    const niMin = Math.max(0, Math.floor((oy0 - nm.y0) / nm.step));
    const niMax = Math.min(nm.height - 2, Math.floor((oy1 - nm.y0) / nm.step));
    for (let j = 0; j < oldCellCols; j++) {
      if (oldDem.cellValid[i * oldCellCols + j] === 0) continue;
      const ox0 = om.x0 + j * om.step;
      const ox1 = ox0 + om.step;
      const njMin = Math.max(0, Math.floor((ox0 - nm.x0) / nm.step));
      const njMax = Math.min(nm.width - 2, Math.floor((ox1 - nm.x0) / nm.step));
      for (let ni = niMin; ni <= niMax; ni++) {
        const yLo = Math.max(oy0, nm.y0 + ni * nm.step);
        const yHi = Math.min(oy1, nm.y0 + (ni + 1) * nm.step);
        if (yHi <= yLo) continue;
        for (let nj = njMin; nj <= njMax; nj++) {
          if (newDem.cellValid[ni * newCellCols + nj] === 0) continue;
          const xLo = Math.max(ox0, nm.x0 + nj * nm.step);
          const xHi = Math.min(ox1, nm.x0 + (nj + 1) * nm.step);
          if (xHi <= xLo) continue;

          // 交集矩形四角上的 旧-新 差值（局部坐标，角序 00/10/01/11）
          const d00 =
            sampleCell(oldDem, i, j, xLo, yLo) -
            sampleCell(newDem, ni, nj, xLo, yLo);
          const d10 =
            sampleCell(oldDem, i, j, xHi, yLo) -
            sampleCell(newDem, ni, nj, xHi, yLo);
          const d01 =
            sampleCell(oldDem, i, j, xLo, yHi) -
            sampleCell(newDem, ni, nj, xLo, yHi);
          const d11 =
            sampleCell(oldDem, i, j, xHi, yHi) -
            sampleCell(newDem, ni, nj, xHi, yHi);

          const hx = xHi - xLo;
          const hy = yHi - yLo;
          area.add(hx * hy);
          cut.add(integratePositivePartBilinear(hx, hy, d00, d10, d01, d11));
          fill.add(integratePositivePartBilinear(hx, hy, -d00, -d10, -d01, -d11));
        }
      }
    }
  }

  return {
    commonArea: area.value,
    cutVolume: cut.value / CUBIC_METERS_PER_CUBIC_YARD,
    fillVolume: fill.value / CUBIC_METERS_PER_CUBIC_YARD,
  };
}
