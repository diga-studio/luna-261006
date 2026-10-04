# task26100625
# headcount-planner

内存态人力编制分配库，供上层规划工具直接调用（无接口层、无持久化）。

## 用法

```ts
import { generatePlan, evaluatePlan } from 'headcount-planner';

const plan = generatePlan(snapshot);            // 不修改 snapshot，也不改变当前分配
const stats = evaluatePlan(snapshot, plan);     // { highFilled, mediumFilled, lowFilled, totalScore, moves }
```

- `snapshot` 包含员工、需求项、候选配对（匹配分 0–100 整数）、当前分配及其中被冻结的子集、部门/职族人数上限。
- 冻结分配原样保留并照常占用需求人数与两层额度；其余当前分配允许调整。
- 目标按严格字典序：高优先级已配人数 → 中 → 低 → 匹配分总和 → 最少换岗（原已分配员工去向变化或变为未分配计 1 次换岗）。
- 求解基于最小费用流，权重使用 bigint，保证全局最优而非近似。

## 构建与测试

```sh
npm install
npm test
```

仅需 Node.js；`npm test` 先编译（tsc）再运行 node:test 测试。
