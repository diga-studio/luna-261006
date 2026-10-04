import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeDEM } from '../src/writeDEM';
import { compareDEMs } from '../src/compareDEMs';
import { CUBIC_METERS_TO_CUBIC_YARDS, type DEMMeta } from '../src/types';

async function makeDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dem-test-'));
}

async function* rowsOf(rows: number[][]): AsyncGenerator<Float64Array> {
  for (const row of rows) yield Float64Array.from(row);
}

async function writeGrid(
  dir: string,
  meta: DEMMeta,
  rows: number[][],
): Promise<void> {
  await writeDEM(dir, meta, rowsOf(rows));
}

test('单位正方形解析解：旧面为 0，新面为 x*y-0.25', async (t) => {
  const oldDir = await makeDir();
  const newDir = await makeDir();
  t.after(() => Promise.all([rm(oldDir, { recursive: true, force: true }), rm(newDir, { recursive: true, force: true })]));

  const meta: DEMMeta = { width: 2, height: 2, x0: 0, y0: 0, step: 1 };
  await writeGrid(oldDir, meta, [
    [0, 0],
    [0, 0],
  ]);
  // 节点值即 x*y-0.25 在角点的取值；xy 是双线性函数，插值后精确等于原函数
  await writeGrid(newDir, meta, [
    [-0.25, -0.25],
    [-0.25, 0.75],
  ]);

  const result = await compareDEMs(oldDir, newDir);
  const expectedM3 = (3 + 2 * Math.log(4)) / 64;
  const expectedYd3 = expectedM3 * CUBIC_METERS_TO_CUBIC_YARDS;

  assert.ok(Math.abs(result.area - 1) < 1e-12, `area=${result.area}`);
  assert.ok(Math.abs(result.cut - expectedYd3) < 1e-9, `cut=${result.cut}, expected=${expectedYd3}`);
  assert.ok(Math.abs(result.fill - expectedYd3) < 1e-9, `fill=${result.fill}, expected=${expectedYd3}`);
});

test('不同分辨率、原点不对齐、含内部 NaN 的两份网格', async (t) => {
  const oldDir = await makeDir();
  const newDir = await makeDir();
  t.after(() => Promise.all([rm(oldDir, { recursive: true, force: true }), rm(newDir, { recursive: true, force: true })]));

  // 旧网格：step=1，节点 x∈{0,1,2,3}，y∈{0,1,2}，高程全 0，
  // 节点 (i=1,j=0) 为 NoData，使单元 (0,0)、(1,0) 无效。
  const oldMeta: DEMMeta = { width: 4, height: 3, x0: 0, y0: 0, step: 1 };
  await writeGrid(oldDir, oldMeta, [
    [0, NaN, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]);

  // 新网格：step=0.5，原点 (0.25,-0.5)，5x5 节点，高程为平面 z=x-1.3，
  // 节点 (i=2,j=2)（即 x=1.25,y=0.5）为 NoData，使其周围 4 个单元无效。
  const newMeta: DEMMeta = { width: 5, height: 5, x0: 0.25, y0: -0.5, step: 0.5 };
  const newRows: number[][] = [];
  for (let j = 0; j < 5; j++) {
    const row: number[] = [];
    for (let i = 0; i < 5; i++) {
      const x = 0.25 + 0.5 * i;
      row.push(i === 2 && j === 2 ? NaN : x - 1.3);
    }
    newRows.push(row);
  }
  await writeGrid(newDir, newMeta, newRows);

  // 手算（见 README）：
  // 比较域 = [2,2.25]x[0,1] ∪ [0.25,2.25]x[1,1.5]，面积 0.25+1=1.25 平方米
  // d = 旧-新 = 1.3-x；挖方（x<1.3 部分）= 0.275625 立方米
  // 填方（x>1.3 部分）= 0.20625+0.225625 = 0.431875 立方米
  const expectedArea = 1.25;
  const expectedCutM3 = 0.275625;
  const expectedFillM3 = 0.431875;

  const result = await compareDEMs(oldDir, newDir);
  assert.ok(Math.abs(result.area - expectedArea) < 1e-12, `area=${result.area}`);
  assert.ok(
    Math.abs(result.cut - expectedCutM3 * CUBIC_METERS_TO_CUBIC_YARDS) < 1e-9,
    `cut=${result.cut}`,
  );
  assert.ok(
    Math.abs(result.fill - expectedFillM3 * CUBIC_METERS_TO_CUBIC_YARDS) < 1e-9,
    `fill=${result.fill}`,
  );

  // 交换新旧：面积不变，挖填互换
  const swapped = await compareDEMs(newDir, oldDir);
  assert.equal(swapped.area, result.area);
  assert.equal(swapped.cut, result.fill);
  assert.equal(swapped.fill, result.cut);
});

test('无共同有效区域时三个结果均为 0', async (t) => {
  const aDir = await makeDir();
  const bDir = await makeDir();
  const cDir = await makeDir();
  t.after(() => Promise.all([aDir, bDir, cDir].map((d) => rm(d, { recursive: true, force: true }))));

  // 区域不相交
  await writeGrid(aDir, { width: 2, height: 2, x0: 0, y0: 0, step: 1 }, [
    [1, 1],
    [1, 1],
  ]);
  await writeGrid(bDir, { width: 2, height: 2, x0: 10, y0: 10, step: 1 }, [
    [2, 2],
    [2, 2],
  ]);
  // 区域相交但一方全部 NoData
  await writeGrid(cDir, { width: 2, height: 2, x0: 0, y0: 0, step: 1 }, [
    [NaN, NaN],
    [NaN, NaN],
  ]);

  for (const [oldDir, newDir] of [[aDir, bDir], [aDir, cDir]] as const) {
    const result = await compareDEMs(oldDir, newDir);
    assert.deepEqual(result, { area: 0, cut: 0, fill: 0 });
  }
});

test('writeDEM 输入校验', async (t) => {
  const dir = await makeDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const meta: DEMMeta = { width: 2, height: 2, x0: 0, y0: 0, step: 1 };

  await assert.rejects(
    writeDEM(join(dir, 'bad-step'), { ...meta, step: 2 }, rowsOf([[0, 0], [0, 0]])),
    /step/,
  );
  await assert.rejects(
    writeDEM(join(dir, 'bad-width'), meta, rowsOf([[0, 0, 0], [0, 0]])),
    /length|width/i,
  );
  await assert.rejects(
    writeDEM(join(dir, 'bad-rows'), meta, rowsOf([[0, 0]])),
    /rows/,
  );
});
