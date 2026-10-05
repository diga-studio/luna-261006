# quota-exam-bank

职业认证考试的受配额随机组卷库（TypeScript）。只负责生成试卷，不包含作答流程。

## 使用

```bash
npm install
npm test        # 编译并运行全部测试
npm run build   # 仅编译到 dist/
```

```ts
import { snapshotBank, assembleExam } from "quota-exam-bank";

const bank = snapshotBank(versions); // 深拷贝快照；同一 questionId 只保留最大 version

const result = assembleExam(
  bank,
  { 代数: 2, 几何: 1 },        // 类别配额：非负整数，未列出类别为 0
  { 基础: 2, 进阶: 1 },        // 难度配额：基础/进阶/高阶，总数须与类别一致
  [["q1", "q2"], ["q1"]],      // 历史试卷的 questionId 列表
  "student-42-attempt-1",      // seed 字符串
);

if (result.ok) {
  // result.questions 精确满足两侧配额，顺序稳定
  // result.repeats   重复题数量（已最小化）
  // result.totalCost 随机成本总和（BigInt，已在同重复数下最小化）
} else {
  // 不存在合法试卷；绝不返回部分试卷
}
```

## 规则

- **版本**：`questionId` 跨版本不变，只有最大 `version` 参与组卷。
- **配额**：类别与难度不是独立题池，试卷须同时精确满足两侧配额；同一 `questionId` 最多出现一次。
- **两级优化**（字典序）：
  1. 最小化重复题数量——`questionId` 出现在 history 任意试卷即算一道重复题（修订换类别也算；多份历史出现只计一次）。题库不足以避开重复时返回重复最少的合法试卷而非失败。
  2. 重复数相同再最小化随机成本总和：每题成本为 `SHA-256(JSON.stringify([seed, questionId]))` 摘要前 4 字节的大端无符号整数，以 BigInt 精确求和比较。
- **确定性**：相同输入与 seed 必得相同试卷（含题目顺序）；版本列表与历史列表的输入顺序不影响结果。两项成本仍相同时由确定性的最小费用流算法给出稳定取舍。

## 实现

组卷建模为最小费用最大流（`src/mincostflow.ts`，SSP + 势函数 Dijkstra，BigInt 成本）：
源→类别（容量=类别配额）→难度（每题一条容量 1 的边，成本 = 重复标记×BIG + 随机成本）→汇（容量=难度配额）。流量不足配额总数即无解。
