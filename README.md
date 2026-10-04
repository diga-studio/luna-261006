# FirstDay Buddy — 批量导师匹配库

进程内单次规划：为一批新人规划导师配对，保留经理强制指定，并使兼容度评分与最终负载一致。不包含人员资料管理。

## 使用

```bash
npm install
npm test
```

```ts
import { planBatch, evaluatePlan } from "firstday-buddy";

const plan = planBatch({ newcomers, mentors, forced });
// plan.feasible === false 时表示强制指定相互冲突，无可行方案
// 否则 plan.assignments / plan.unassignedNewcomerIds / plan.matchedCount /
// plan.scores / plan.totalScore 给出最优方案及其目标值

const check = evaluatePlan(input, plan.assignments);
// check.valid / check.violations 校验合法性，并重新计算目标值（不信任方案附带的分数）
```

## 模型与算法

- 导师最终负载 = 历史活跃配对数（0–3，不可移动）+ 本批配对数（含强制指定），上限 3。
- 兼容度 = 部门 30 + 办公地点 10 + 共同兴趣（每个 5，上限 25）+ 任职固定 20 + 负载项（最终负载 1/2/3 → 15/7.5/0，同一导师下本批所有新人相同）。
- 目标为字典序：先最大化本批配对人数，再最大化总分（总分只含本批配对）。
- 实现为最小费用流（SSP + Johnson 势）：增广到最大流保证人数最优，费用平移为每单位流量的常数（不混合两个目标），负载项通过导师汇点侧的容量 1 槽位边按边际贡献 `b·w(h+b) − (b−1)·w(h+b−1)` 精确建模。
- 规模：300 新人 / 200 导师 / 60000 候选关系，实测单次规划约 0.2 秒。
