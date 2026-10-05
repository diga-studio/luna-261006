# endpoint-sequence-detector

进程内端点遥测序列检测库（TypeScript）。对每条规则与每个结束事件，输出以该事件
收尾的**精确证据链数量**（十进制字符串，BigInt 精度），而不是展开证据或只报布尔命中。

## 安装与测试

```sh
npm install
npm test
```

只依赖 Node.js（>= 18）与 devDependencies 中的 `typescript` / `@types/node`，无运行时依赖。

## API

```ts
import { createDetector } from "endpoint-sequence-detector";

const detector = createDetector(rules);   // rules: 已解析对象，创建后不可变
const hits = detector.ingest(events);     // 本批新产生的命中摘要
detector.advanceTo(t);                    // 无新事件时推进时间、淘汰过期状态
```

- 规则：`{ ruleId, windowMs, stages }`，2 至 8 个有序阶段；每阶段为
  `eventType` 加若干 payload 字符串等值条件（全部满足才匹配，缺字段不匹配）。
- 事件：`{ eventId, agentId, ts, eventType, payload }`，`eventId` 全局唯一，
  按整数毫秒 `ts` 非递减到达，相同 `ts` 保持输入顺序（跨批次一致）。
- 命中摘要：`{ ruleId, agentId, eventId, count }`，`count` 为十进制字符串；
  `count` 为 0 时不输出。
- 时间只能前进：`ingest` 会把时间推进到正在处理的事件 `ts`，`advanceTo(t)`
  与后续事件的 `ts` 都不得小于当前时间（违反时抛错）。

合法证据链：同一 agent 的事件按输入顺序严格递增、逐一匹配对应阶段、首尾事件
`ts` 之差 `<= windowMs`（边界包含等于）。事件不要求相邻，不同链可复用事件，
同一链不重复使用事件；链的身份仅由 `eventId` 序列决定。

## 算法与复杂度

关键观察：由于事件按 `ts` 非递减到达，合法链的所有事件必然都落在
`[ts_last - W, ts_last]` 内，因此窗口约束等价于"整链都在当前滑窗内"。

对每个 `(rule, agent)` 维护一个滑窗聚合（SWAG，双栈结构）。把事件段映射为
`(k+1)` 阶上三角矩阵：`M[a][b]` 表示段内匹配阶段 `a+1..b` 的子序列数量，
相邻段的合并即矩阵乘法（结合律成立），单个事件是对角线上记录其阶段匹配
位掩码的矩阵。每个新事件到达时：

1. 按 `ts < now - W` 淘汰过期事件（摊销 O(1) 次矩阵合并）；
2. 若事件匹配最终阶段，查询窗口聚合矩阵的 `M[0][k-1]`，即为以该事件收尾的
   完整证据链数；
3. 把事件的叶子矩阵压入栈（O(1) 次合并）。

计数全部使用 BigInt，精确无近似。固定规则数与阶段数后，单事件摊销成本为
`O(k^3)` 次整数运算（`k <= 8`），与窗口内事件数无关；淘汰成本摊到被淘汰事件上。
常驻状态只随未过期事件、活跃 agent 与规则规模增长；`advanceTo` 越过所有窗口后，
历史事件与空闲 agent 的状态被完全释放。

## 测试

- `test/detector.test.ts`：与独立穷举参照（`test/reference.ts`，保留全部历史做
  O(n²·k) DP）逐项对比。覆盖重复阶段、单事件匹配多阶段、相同时间戳、窗口边界
  （恰好等于 W）、多 agent 交错、谓词包含关系、不同批次切分与合法 `advanceTo`
  下结果一致，以及时间回退与非法规则的报错；另含 30 轮随机模糊对比。
- `test/perf/performance.check.ts`：20 万事件持续滑窗（同一 agent 每毫秒一个事件、
  8 个完全相同阶段、W=10000），逐条用独立组合数 `C(min(i,10000),7)` 核对每个结束
  事件的 `count`（稳态值远超 `Number.MAX_SAFE_INTEGER`），并记录耗时与堆内存变化，
  验证全部过期后常驻状态回落。
