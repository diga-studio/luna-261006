import { test } from "node:test";
import { compareDEMs } from "../src/index";
import { assertClose, CUBIC_METERS_PER_CUBIC_YARD, writeTestDEM } from "./helpers";

// 单位正方形：旧表面恒为 0，新表面为 x*y - 0.25（双线性，可被网格精确表示）。
// 解析结果：有效面积 1 平方米，挖方 = 填方 = (3 + 2*ln(4)) / 64 立方米。
test("单位正方形解析解", async () => {
  const meta = { width: 2, height: 2, x0: 0, y0: 0, step: 1 };
  const oldDir = await writeTestDEM(meta, [
    [0, 0],
    [0, 0],
  ]);
  const newDir = await writeTestDEM(meta, [
    [-0.25, -0.25], // y=0 行：x=0 -> -0.25, x=1 -> -0.25
    [-0.25, 0.75], //  y=1 行：x=0 -> -0.25, x=1 -> 0.75
  ]);

  const expected = (3 + 2 * Math.log(4)) / 64 / CUBIC_METERS_PER_CUBIC_YARD;

  const result = await compareDEMs(oldDir, newDir);
  assertClose(result.commonArea, 1, 1e-12, "commonArea");
  assertClose(result.cutVolume, expected, 1e-12, "cutVolume");
  assertClose(result.fillVolume, expected, 1e-12, "fillVolume");

  // 交换新旧：挖填互换，面积不变
  const swapped = await compareDEMs(newDir, oldDir);
  assertClose(swapped.commonArea, 1, 1e-12, "swapped commonArea");
  assertClose(swapped.cutVolume, expected, 1e-12, "swapped cutVolume");
  assertClose(swapped.fillVolume, expected, 1e-12, "swapped fillVolume");
});
