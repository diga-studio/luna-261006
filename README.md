# FirstDay Buddy 批量导师匹配库

进程内单次规划：为一批新人（newcomer）批量分配导师（mentor），保留经理强制指定，
并使兼容度评分与导师最终负载一致。不包含人员资料管理。

## 使用

```ts
import { planBatch, evaluatePlan } from "firstday-buddy-matcher";

const result = planBatch({
  newcomers,        // { id, department, location, interests, candidateMentorIds }
  mentors,          // { id, department, location, interests, activeMenteeCount }
  forcedAssignments // [{ newcomerId, mentorId }]
});

if (result.feasible) {
  result.assignments;            // 配对方案（含强制指定）
  result.unassignedNewcomerIds;  // 未分配新人
  result.objective;              // { matchedCount, totalScore }
} else {
  result.reason;                 // 强制指定冲突等原因
}

// 校验方案并重新计分（不相信方案附带的分数）
const evaluation = evaluatePlan(input, result.assignments);
```

## 规则

- 每名新人最多一名导师，允许未分配；导师最终负载 = 历史活跃配对数 + 本批配对数 ≤ 3。
- 强制指定必须属于候选集合且必须保留；相互冲突时 `planBatch` 返回 `feasible: false`。
- 兼容度：同部门 30，同办公地点 10，共同兴趣每个 5（上限 25），任职项固定 20，
  负载项按导师最终负载 1/2/3 计 15 / 7.5 / 0（本批所有新人含强制指定一致适用）。
- 目标字典序：先最大化本批配对人数，再最大化总分（总分只含本批配对）。

## 算法

精确最小费用最大流（SSP + Johnson 势函数）：

- 源 → 新人（容量 1），新人 → 候选导师（容量 1，费用 = -2 × 固定部分得分）。
- 导师 → 汇按单位容量拆边，第 k 条边费用 = -2 × 负载项边际收益
  `g(k) = (f+k)·L(c+f+k) − (f+k−1)·L(c+f+k−1)`（c 历史负载，f 强制指定数）。
  边际收益单调不增（凸），单位边模型精确。
- 强制指定先从网络移除并扣减容量；求解后按导师最终负载为强制与自动配对统一计分。
- 每次沿最小费用增广路增广直至最大流，直接得到“先人数最多、再总分最高”的字典序
  最优，不使用大常数混合目标。所有费用 ×2 保持整数（7.5 → 15）。

规模 300 新人 / 200 导师 / 60000 候选关系时，单次规划约 0.2~0.5 秒（限制 20 秒）。

## 构建与测试

```sh
npm install
npm test        # tsc 编译后运行 node:test 测试
```

测试包括：小规模随机实例与测试内穷举最优对照（覆盖候选重叠、容量不足、强制冲突）、
单候选新人不被抢占名额、负载项重计分的 150/145 基准场景、evaluatePlan 合法性检查，
以及 300/200/60000 全量规模的可重复端到端规划验证。
