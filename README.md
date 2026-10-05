# task26100660 — RetainEdge 风险规则预览库

TypeScript 实现的 RetainEdge 预警规则预览库，由上层直接调用，学生快照保存在进程内存中。

## 功能

- 装载固定学期的只读学生快照：唯一学号 + 六个已计算的布尔指标。
- 基准规则：权重 25/20/15/10/15/10，总分封顶 100；低档 <40，中档 [40,70)，高档 ≥70（分数等于边界进入较高档）。
- 候选方案可独立修改六个权重与中、高两条边界（均为整数；权重 0–100；中边界非负且严格小于高边界；高边界 ≤100）。
- `preview(candidate)`：返回 3×3 迁移人数矩阵，以及各迁移方向下每份解释对应的人数（同一学生有多份解释时分别计数）。
- `previewStudent(id, candidate)`：按学号查看前后分数、档位与全部换档解释。
- 解释 = 实际发生变化的最小充分参数集合（只把集合内参数改为候选值即可到达候选档位；中间规则必须合法；不存在合法的真子集同样充分）。全部符合条件的解释都会返回。
- 每个候选方案都从基准独立计算，预览之间互不污染。

## 使用

```ts
import { RetainEdgePreview } from './src';

const engine = new RetainEdgePreview(students); // students: Iterable<StudentInput>

const result = engine.preview({
  weights: { gpaBelow2: 40, attendanceBelow75: 25, aidIncomplete: 20 },
});
// result.migration.mid.high          —— 中档升到高档的人数
// result.explanations['mid->high']   —— [{ params: ['weight:gpaBelow2'], count: ... }, ...]

const one = engine.previewStudent('S0001', { midThreshold: 80, highThreshold: 90 });
// one.explanations === [['threshold:mid', 'threshold:high']]
```

## 实现要点

六布尔指标只有 64 种组合，装载时按组合分桶计数；每次预览只评估 64 个桶，
解释按指标组合枚举变化参数的全部子集（至多 2^8 个）并筛选最小充分集，
因此百万学生 × 千次预览的开销与学生数无关。

## 构建与测试

```sh
npm install
npm test
```

测试覆盖：打分/分档/参数校验、验收指定的两个解释案例、权重升降与 100 分封顶组合、
优化路径与朴素逐学生重算的随机交叉验证（迁移人数与解释完全一致）、
多次预览不污染基准、以及下述规模基准。

## 耗时记录

环境：macOS 26.7 (arm64)，Node.js v24.11.1。

| 阶段 | 耗时 |
| --- | --- |
| 装载 1,000,000 名学生（不计入预算） | ~0.9 s |
| 1000 个不同候选方案的完整预览（含解释人数统计） | **~48 ms 总计（约 0.05 ms/次）**，预算 10 s |

每次预览后均断言：有迁移的方向必须带有解释统计，且解释人数之和 ≥ 迁移人数；
并抽样 3 个方案对全部 100 万学生逐人重算，迁移矩阵完全一致。
实测输出见 `npm test` 中 `benchmark` 用例的日志。
