// 随机用例交叉验证：先运行 `python3 reference/crosscheck_random.py > /tmp/cases.json`，
// 再运行 `node reference/crosscheck_random.mjs`。
// 将库的输出与 Python 精确分数（Fraction）全枚举参考逐一对比，容差 1e-10。
import { readFileSync } from "node:fs";
import { compareVariants } from "../dist/src/index.js";
const cases = JSON.parse(readFileSync("/tmp/cases.json", "utf8"));
let worst = 0;
let bad = 0;
for (const c of cases) {
  const variants = c.ns.map((n, i) => ({ exposure: n, converted: c.xs[i] }));
  const r = compareVariants(variants);
  const dp = Math.abs(r.pValue - c.p);
  worst = Math.max(worst, dp);
  if (dp > 1e-10) {
    bad++;
    console.log(`BAD ns=[${c.ns}] xs=[${c.xs}] p=${r.pValue} ref=${c.p}`);
  }
}
console.log(`${cases.length} cases, worst |dp| = ${worst.toExponential(3)}, bad = ${bad}`);
