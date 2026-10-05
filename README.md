# endpoint-sequence-detector

进程内端点遥测序列检测库：对有序阶段规则做滑窗精确计数。同一个结束事件
对应多少条合法证据链，就输出多少（十进制字符串，BigInt 精确值），不展开
证据、不做布尔命中、不做截断或近似。

## 要求

- Node.js >= 22.6（使用内置 TypeScript 类型擦除与 `node:test`，零依赖）。
- `npm install && npm test` 即可运行全部测试。

## API

```ts
import { createDetector } from "./src/detector.ts";

const detector = createDetector([
  {
    ruleId: "priv-esc-chain",
    windowMs: 10_000,              // 窗口 W，毫秒；首尾 ts 之差 <= W 含等号
    stages: [                      // 2 至 8 个有序阶段
      { eventType: "exec", payloadEquals: { user: "root" } },
      { eventType: "write", payloadEquals: { path: "/etc/passwd" } },
    ],
  },
]);

const hits = detector.ingest(events); // -> [{ ruleId, agentId, eventId, count }]
detector.advanceTo(t);                // 无新事件时推进时间、淘汰过期状态
```

- 事件：`{ eventId, agentId, ts, eventType, payload? }`，按整数毫秒 ts 非递减
  到达，相同 ts 保持输入先后。`payloadEquals` 全部为字符串等值条件，全部满足
  才匹配，缺字段不匹配。
- `ingest` 返回本批新产生的命中摘要；`count` 是以该事件为最后阶段、窗口
  `[ts - W, ts]` 内同一 agent 的合法事件序列（按输入顺序严格递增）的精确
  条数；`count` 为 0 不输出。
- 时间只能前进：`advanceTo(t)` 与事件 ts 不得小于当前时间，否则抛错。
- 规则在创建时被深拷贝并冻结，之后修改入参不影响检测器。

## 算法与复杂度

- 每个 `(agent, rule)` 维护一个滑窗聚合队列（SWAG，双栈结构），聚合值是
  一个"子序列计数幺半群"：对 k 个阶段记录所有 `cnt(a, b)` = 窗口内匹配阶段
  a..b 的子序列条数（BigInt）。合并两段序列只需 O(k^3) 次整数运算。
- 结束事件 e 的命中数 = 窗口聚合值中的 `cnt(1, k-1)`（e 充当阶段 k），
  无需枚举任何证据链。
- 摊销成本：每个事件 O(规则数 × k^3) 次 BigInt 运算，与窗口内事件数无关
  （整数位宽影响除外）；淘汰成本摊到被淘汰事件上。
- 常驻状态只随未过期事件、活跃 agent 与规则规模增长；`advanceTo` 越过所有
  窗口后清空全部历史事件与空闲 agent 状态。

## 测试

- `tests/detector.test.ts`：场景测试（重复阶段、单事件匹配多阶段、相同
  时间戳、窗口边界、多 agent 交错、批次切分与 `advanceTo` 不变性等）+
  对独立穷举参照（`tests/reference.ts`）的随机模糊比对。
- `tests/stress.test.ts`：20 万事件持续滑窗（8 个完全相同阶段，W=10000），
  逐条核对 `count = C(min(n, W), 7)`（BigInt 组合数，远超 2^53），记录耗时
  与内存。
- `tests/memory.test.ts` / `tests/memory.check.ts`：子进程中验证多轮流量
  与大量空闲 agent 之后常驻内存回落到基线。
