# workforce-allocation

人力编制分配库（纯内存、无接口层），供上层规划工具调用：载入规划快照，
在保护冻结分配与两层编制额度的前提下，生成字典序最优的分配方案。

## 使用

```ts
import { solveSnapshot, type PlanningSnapshot } from 'workforce-allocation';

const snapshot: PlanningSnapshot = { employees, demands, candidates, departments,
  familyCapacities, currentAssignments, frozenAssignments };
const plan = solveSnapshot(snapshot);
// plan.assignments: 新方案的全部分配（含原样保留的冻结分配）
// plan.metrics:     五项目标值（高/中/低已补人数、匹配分之和、换岗人数）
```

求解不修改输入快照，也不会把方案写回为当前分配；快照与方案都只存在于内存。

## 规则

- 候选配对由上游给出（匹配分 0-100 整数），未列出的员工×需求组合不会匹配。
- 每名员工最多分配到一个需求项；每项分配人数不超过需求人数；允许未分配/未补满。
- 部门有总人数上限；部门内职族另有上限（仅约束本部门本职族）。
  一次分配同时占用部门与部门内职族两层额度。
- 冻结分配原样保留并照常占用需求人数与两层额度；其余当前分配允许调整。
- 需求项所属部门必须在 `departments` 中有上限；`familyCapacities` 中未列出的
  （部门, 职族）组合视为该层不设额外上限。

## 目标（严格字典序，后者不能抵消前者）

1. 最大化高优先级需求的已分配人数
2. 最大化中优先级人数
3. 最大化低优先级人数
4. 最大化所有已分配配对的匹配分之和
5. 最小化换岗人数（原本已分配且新去向不同，含变为未分配；原本未分配不计入）

## 实现

把问题建成最小费用流：源点→员工→需求项→(部门,职族)→部门→汇点，
员工另有流向“未分配”汇点的边。五项目标用逐级放大的 bigint 权重编码进
单一费用，保证严格字典序；冻结分配在建图前预先扣除额度。

## 开发

```sh
npm install   # 仅需 Node.js；安装 typescript 与 @types/node
npm test      # 编译并运行 node:test 测试（含暴力枚举对照）
npm run build # 输出到 dist/
```
