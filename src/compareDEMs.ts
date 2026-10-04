import { readFile } from 'node:fs/promises';
import { endianness } from 'node:os';
import { join } from 'node:path';
import {
  ALLOWED_STEPS,
  CUBIC_METERS_TO_CUBIC_YARDS,
  type CompareResult,
  type DEMMeta,
} from './types';

interface DEM {
  meta: DEMMeta;
  /** 行主序节点高程：data[j * width + i]，j 沿 y、i 沿 x */
  data: Float64Array;
}

async function readDEM(directory: string): Promise<DEM> {
  const metaRaw = await readFile(join(directory, 'meta.json'), 'utf8');
  const meta = JSON.parse(metaRaw) as DEMMeta;
  if (
    !Number.isInteger(meta.width) || meta.width < 1 ||
    !Number.isInteger(meta.height) || meta.height < 1 ||
    !Number.isFinite(meta.x0) || !Number.isFinite(meta.y0) ||
    !ALLOWED_STEPS.includes(meta.step)
  ) {
    throw new Error(`invalid meta.json in ${directory}`);
  }
  const bin = await readFile(join(directory, 'elevation.bin'));
  const expected = meta.width * meta.height * 8;
  if (bin.byteLength !== expected) {
    throw new Error(
      `elevation.bin in ${directory} has ${bin.byteLength} bytes, expected ${expected}`,
    );
  }
  // 拷贝到独立 ArrayBuffer，避免 Buffer 池化导致的对齐问题
  const ab = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength);
  const data = new Float64Array(ab);
  if (endianness() !== 'LE') {
    for (let k = 0; k < data.length; k++) {
      const view = new DataView(ab, k * 8, 8);
      view.setFloat64(0, view.getFloat64(0, true), false);
    }
  }
  return { meta, data };
}

/** 单元 (i,j) 四角均非 NoData 时有效 */
function cellValid(dem: DEM, i: number, j: number): boolean {
  const { width, height } = dem.meta;
  if (i < 0 || j < 0 || i + 1 >= width || j + 1 >= height) return false;
  const base = j * width + i;
  return (
    !Number.isNaN(dem.data[base]) &&
    !Number.isNaN(dem.data[base + 1]) &&
    !Number.isNaN(dem.data[base + width]) &&
    !Number.isNaN(dem.data[base + width + 1])
  );
}

/** 双线性插值采样（调用方保证 (x,y) 在网格覆盖范围内） */
function sample(dem: DEM, x: number, y: number): number {
  const { x0, y0, step, width, height } = dem.meta;
  const i = Math.min(width - 2, Math.max(0, Math.floor((x - x0) / step)));
  const j = Math.min(height - 2, Math.max(0, Math.floor((y - y0) / step)));
  const u = (x - (x0 + i * step)) / step;
  const v = (y - (y0 + j * step)) / step;
  const base = j * width + i;
  const z00 = dem.data[base];
  const z10 = dem.data[base + 1];
  const z01 = dem.data[base + width];
  const z11 = dem.data[base + width + 1];
  return (
    z00 * (1 - u) * (1 - v) +
    z10 * u * (1 - v) +
    z01 * (1 - u) * v +
    z11 * u * v
  );
}

/** 一维线性函数（端点值 p0、p1，区间长 dy）正部的精确积分 */
function positivePartOfLinear(p0: number, p1: number, dy: number): number {
  if (p0 <= 0 && p1 <= 0) return 0;
  if (p0 >= 0 && p1 >= 0) return 0.5 * (p0 + p1) * dy;
  if (p0 > 0) return (0.5 * p0 * p0 * dy) / (p0 - p1);
  return (0.5 * p1 * p1 * dy) / (p1 - p0);
}

/** 自适应 Simpson（Richardson 误差估计），f 定义在 [0,1] 上 */
function adaptiveSimpson(f: (t: number) => number, tol: number): number {
  const f0 = f(0);
  const fHalf = f(0.5);
  const f1 = f(1);
  const whole = (f0 + 4 * fHalf + f1) / 6;
  return simpsonStep(f, 0, 1, f0, fHalf, f1, whole, tol, 50);
}

function simpsonStep(
  f: (t: number) => number,
  a: number,
  b: number,
  fa: number,
  fm: number,
  fb: number,
  whole: number,
  tol: number,
  depth: number,
): number {
  const m = (a + b) / 2;
  const lm = (a + m) / 2;
  const rm = (m + b) / 2;
  const flm = f(lm);
  const frm = f(rm);
  const left = ((m - a) / 6) * (fa + 4 * flm + fm);
  const right = ((b - m) / 6) * (fm + 4 * frm + fb);
  const err = left + right - whole;
  if (depth <= 0 || Math.abs(err) <= 15 * tol) {
    return left + right + err / 15;
  }
  return (
    simpsonStep(f, a, m, fa, flm, fm, left, tol / 2, depth - 1) +
    simpsonStep(f, m, b, fm, frm, fb, right, tol / 2, depth - 1)
  );
}

/**
 * 矩形 [x0,x1]x[y0,y1] 上双线性函数（四角值 f00,f10,f01,f11）正部的积分。
 * 固定 x 时函数关于 y 线性，内层积分精确；外层用自适应 Simpson。
 */
function integratePositivePart(
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  f00: number,
  f10: number,
  f01: number,
  f11: number,
): number {
  const dy = y1 - y0;
  const g = (t: number): number => {
    const p0 = f00 + (f10 - f00) * t;
    const p1 = f01 + (f11 - f01) * t;
    return positivePartOfLinear(p0, p1, dy);
  };
  const maxAbs = Math.max(Math.abs(f00), Math.abs(f10), Math.abs(f01), Math.abs(f11));
  const tol = 1e-12 * dy * Math.max(1, maxAbs);
  return (x1 - x0) * adaptiveSimpson(g, tol);
}

/** 收集某网格落在开区间 (lo, hi) 内的格线坐标 */
function collectLines(
  x0: number,
  step: number,
  count: number,
  lo: number,
  hi: number,
  out: number[],
): void {
  const eps = 1e-9 * step;
  const iMin = Math.max(0, Math.ceil((lo + eps - x0) / step));
  const iMax = Math.min(count - 1, Math.floor((hi - eps - x0) / step));
  for (let i = iMin; i <= iMax; i++) {
    out.push(x0 + i * step);
  }
}

/** 合并两份网格的格线，得到排序去重后的剖分坐标 */
function mergedLines(
  a0: number,
  aStep: number,
  aCount: number,
  b0: number,
  bStep: number,
  bCount: number,
  lo: number,
  hi: number,
): number[] {
  const inner: number[] = [];
  collectLines(a0, aStep, aCount, lo, hi, inner);
  collectLines(b0, bStep, bCount, lo, hi, inner);
  inner.sort((p, q) => p - q);
  const eps = 1e-9 * Math.min(aStep, bStep);
  const lines = [lo];
  for (const x of inner) {
    if (x - lines[lines.length - 1] > eps) lines.push(x);
  }
  if (hi - lines[lines.length - 1] > eps) lines.push(hi);
  else lines[lines.length - 1] = hi;
  return lines;
}

/**
 * 比较两份 DEM：返回共同有效面积（平方米）、挖方量与填方量（立方码）。
 * 比较域为两份 DEM 有效单元覆盖区域的交集；挖方为旧减新的正部积分，
 * 填方为新旧差的负部积分，二者独立累计、互不抵消。
 */
export async function compareDEMs(
  oldDirectory: string,
  newDirectory: string,
): Promise<CompareResult> {
  const oldDem = await readDEM(oldDirectory);
  const newDem = await readDEM(newDirectory);

  const xLo = Math.max(oldDem.meta.x0, newDem.meta.x0);
  const xHi = Math.min(
    oldDem.meta.x0 + (oldDem.meta.width - 1) * oldDem.meta.step,
    newDem.meta.x0 + (newDem.meta.width - 1) * newDem.meta.step,
  );
  const yLo = Math.max(oldDem.meta.y0, newDem.meta.y0);
  const yHi = Math.min(
    oldDem.meta.y0 + (oldDem.meta.height - 1) * oldDem.meta.step,
    newDem.meta.y0 + (newDem.meta.height - 1) * newDem.meta.step,
  );
  if (!(xLo < xHi) || !(yLo < yHi)) {
    return { area: 0, cut: 0, fill: 0 };
  }

  const xs = mergedLines(
    oldDem.meta.x0, oldDem.meta.step, oldDem.meta.width,
    newDem.meta.x0, newDem.meta.step, newDem.meta.width,
    xLo, xHi,
  );
  const ys = mergedLines(
    oldDem.meta.y0, oldDem.meta.step, oldDem.meta.height,
    newDem.meta.y0, newDem.meta.step, newDem.meta.height,
    yLo, yHi,
  );

  let area = 0;
  let cutM3 = 0;
  let fillM3 = 0;

  for (let ix = 0; ix + 1 < xs.length; ix++) {
    const x0 = xs[ix];
    const x1 = xs[ix + 1];
    const xMid = (x0 + x1) / 2;
    for (let iy = 0; iy + 1 < ys.length; iy++) {
      const y0 = ys[iy];
      const y1 = ys[iy + 1];
      const yMid = (y0 + y1) / 2;

      const oi = Math.floor((xMid - oldDem.meta.x0) / oldDem.meta.step);
      const oj = Math.floor((yMid - oldDem.meta.y0) / oldDem.meta.step);
      const ni = Math.floor((xMid - newDem.meta.x0) / newDem.meta.step);
      const nj = Math.floor((yMid - newDem.meta.y0) / newDem.meta.step);
      if (!cellValid(oldDem, oi, oj) || !cellValid(newDem, ni, nj)) continue;

      const dx = x1 - x0;
      const dy = y1 - y0;
      area += dx * dy;

      // d = 旧 - 新 在子矩形四角的双线性值
      const d00 = sample(oldDem, x0, y0) - sample(newDem, x0, y0);
      const d10 = sample(oldDem, x1, y0) - sample(newDem, x1, y0);
      const d01 = sample(oldDem, x0, y1) - sample(newDem, x0, y1);
      const d11 = sample(oldDem, x1, y1) - sample(newDem, x1, y1);

      cutM3 += integratePositivePart(x0, x1, y0, y1, d00, d10, d01, d11);
      fillM3 += integratePositivePart(x0, x1, y0, y1, -d00, -d10, -d01, -d11);
    }
  }

  return {
    area,
    cut: cutM3 * CUBIC_METERS_TO_CUBIC_YARDS,
    fill: fillM3 * CUBIC_METERS_TO_CUBIC_YARDS,
  };
}

