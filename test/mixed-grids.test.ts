import { test } from "node:test";
import { compareDEMs } from "../src/index";
import { assertClose, CUBIC_METERS_PER_CUBIC_YARD, writeTestDEM } from "./helpers";

// 手算设计（坐标单位：米）：
// 旧 DEM：原点 (0,0)，step 1，3x3 节点，全部高程 0，仅节点 (x=0,y=0) 为 NaN。
//   有效单元覆盖 = [1,2]x[0,2] ∪ [0,1]x[1,2]（L 形）。
// 新 DEM：原点 (0.5,0.5)，step 0.5，4x4 节点，高程 = x - 1.2，
//   节点 (x=1,y=1) 为 NaN，使其周围 4 个单元失效。
//   有效单元覆盖 = [1.5,2]x[0.5,2] ∪ [0.5,1.5]x[1.5,2]。
// 比较域 D = 三者交集（含半格重叠）：
//   R1 = [1.5,2]x[0.5,2]   面积 0.75
//   R2 = [1,1.5]x[1.5,2]   面积 0.25
//   R3 = [0.5,1]x[1.5,2]   面积 0.25   合计 1.25 平方米
// 差值 旧-新 = 1.2 - x（线性）：
//   R1：x>=1.5 全为填  ∫(x-1.2)dx[1.5,2]*1.5 = 0.275*1.5 = 0.4125
//   R2：跨零点         挖 ∫(1.2-x)dx[1,1.2]*0.5 = 0.02*0.5 = 0.01
//                      填 ∫(x-1.2)dx[1.2,1.5]*0.5 = 0.045*0.5 = 0.0225
//   R3：x<=1 全为挖    ∫(1.2-x)dx[0.5,1]*0.5 = 0.225*0.5 = 0.1125
// 合计：挖 0.1225 立方米，填 0.435 立方米。

const EXPECTED_AREA = 1.25;
const EXPECTED_CUT_M3 = 0.1225;
const EXPECTED_FILL_M3 = 0.435;

async function makeGrids(): Promise<{ oldDir: string; newDir: string }> {
  const oldDir = await writeTestDEM(
    { width: 3, height: 3, x0: 0, y0: 0, step: 1 },
    [
      [NaN, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ],
  );
  const row = [-0.7, -0.2, 0.3, 0.8]; // x - 1.2，x ∈ {0.5, 1.0, 1.5, 2.0}
  const newDir = await writeTestDEM(
    { width: 4, height: 4, x0: 0.5, y0: 0.5, step: 0.5 },
    [row, [-0.7, NaN, 0.3, 0.8], row, row],
  );
  return { oldDir, newDir };
}

test("混合分辨率/原点错开/内部NaN：手算结果一致", async () => {
  const { oldDir, newDir } = await makeGrids();
  const r = await compareDEMs(oldDir, newDir);
  assertClose(r.commonArea, EXPECTED_AREA, 1e-12, "commonArea");
  assertClose(
    r.cutVolume,
    EXPECTED_CUT_M3 / CUBIC_METERS_PER_CUBIC_YARD,
    1e-12,
    "cutVolume",
  );
  assertClose(
    r.fillVolume,
    EXPECTED_FILL_M3 / CUBIC_METERS_PER_CUBIC_YARD,
    1e-12,
    "fillVolume",
  );
});

test("交换新旧只交换挖填，不改变有效面积", async () => {
  const { oldDir, newDir } = await makeGrids();
  const forward = await compareDEMs(oldDir, newDir);
  const swapped = await compareDEMs(newDir, oldDir);
  assertClose(swapped.commonArea, forward.commonArea, 1e-12, "commonArea");
  assertClose(swapped.cutVolume, forward.fillVolume, 1e-12, "cut<->fill");
  assertClose(swapped.fillVolume, forward.cutVolume, 1e-12, "fill<->cut");
});

test("无共同有效区域时三个结果均为0", async () => {
  const a = await writeTestDEM({ width: 2, height: 2, x0: 0, y0: 0, step: 1 }, [
    [1, 2],
    [3, 4],
  ]);
  const b = await writeTestDEM(
    { width: 2, height: 2, x0: 100, y0: 100, step: 1 },
    [
      [1, 2],
      [3, 4],
    ],
  );
  const r = await compareDEMs(a, b);
  assertClose(r.commonArea, 0, 0, "commonArea");
  assertClose(r.cutVolume, 0, 0, "cutVolume");
  assertClose(r.fillVolume, 0, 0, "fillVolume");
});
