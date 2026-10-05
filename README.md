# RetainEdge 风险规则预览库

TypeScript 实现的进程内规则预览库，由上层直接调用。顾问在调整预警规则前，
可以预览哪些学生会换档，并获得每名学生"哪些改动足以导致换档"的解释。

## 构建与测试

干净机器上只需 Node.js：

```bash
npm install
npm test
```

## 使用

```ts
import { RulePreviewEngine, BASELINE_RULES } from "retainedge-rule-preview";

const engine = new RulePreviewEngine(students); // StudentSnapshot[]，只读快照

// 整体预览：九种迁移人数 + 各迁移方向下每份解释的人数
const result = engine.preview({
  weights: [40, 25, 20, 10, 15, 10],
  midThreshold: 40,
  highThreshold: 70,
});
result.transitions.medium.high;        // 中 -> 高 的人数
result.explanations["medium->high"];  // 该方向下每份解释及人数

// 按学号查看前后分数、档位与换档解释
const view = engine.previewStudent(candidate, "S12345");
```

## 规则模型

- 六个布尔指标命中时按权重计分（基准 25/20/15/10/15/10），未命中不计分，总分封顶 100。
- 档位：分数 < 中边界为低风险，[中边界, 高边界) 为中风险，>= 高边界为高风险；等于边界进入较高档。
- 候选方案可修改六个权重与中、高边界：权重为 [0,100] 整数；中边界非负、严格小于高边界；高边界不超过 100。

## 解释语义

- 一份解释是实际发生变化参数的子集：只把子集内参数改为候选值（其余保留基准值）后，
  学生必须到达候选档位（不要求达到候选分数）；混合后的边界必须合法。
- 解释必须极小（不存在同样充分的合法真子集），并返回全部符合条件的解释；
  同一组参数与顺序无关，只算一份。不换档的学生不产生解释。
- 同一学生可有多份解释并分别计数，因此解释人数之和可以超过迁移人数。

## 性能设计

六维布尔指标只有 64 种画像。载入时把每名学生压缩为 6 位掩码并按画像计数，
每次预览只遍历 64 种画像：分数/档位用增量 DP 计算，解释按子集规模递增枚举
（已包含某份解释的超集直接跳过）。预览为只读操作，不改变学生、基准规则或其他方案的结果。

## 耗时记录

`test/perf.test.ts` 每次 `npm test` 都会重跑并打印。本机（Apple Silicon，Node 24）记录：

```
[perf] 1000000 students x 1000 full previews: 1242.6ms (budget 10000ms)
```

即载入 100 万名学生后，连续 1000 个不同候选方案的完整预览（含解释人数统计）
总耗时约 1.2 秒，远低于 10 秒预算；首次载入与结果展示不计入。
