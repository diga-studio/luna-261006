# event-social-matching

进程内存中的活动社交配对库（TypeScript，无接口层、无外部服务）。
会议组织者按兴趣安排多轮一对一交流：每轮给出到场名单，库按轮次
从前往后生成排表，支持确认执行与重排未来轮次。

## 构建与测试

```sh
npm install
npm test
```

只依赖 Node.js 与 `devDependencies` 中的 TypeScript，不需要任何服务。

## API

```ts
import { MatchingEvent } from "event-social-matching";

const ev = new MatchingEvent({
  participants: [
    { id: "a", tags: ["music", "sports"] },
    { id: "b", tags: ["music"] },
    // ...
  ],
  rounds: 12, // 1..12
});

// 为所有未确认轮次（重新）生成排表；attendance[i] 是第
// confirmedCount+i 轮的到场名单。重复调用即重排：保留全部已确认
// 结果，撤销未确认轮次的配对记录与轮空计数后按新名单生成。
const plan = ev.generateSchedule(attendance);
// plan: RoundPlan[] = { round, pairs: [id, id][], byes: id[] }[]

// 按顺序确认下一轮，确认内容就是当前排表中该轮的结果。
ev.confirmNextRound();

ev.getConfirmedRounds();   // 正式历史
ev.getPlannedRounds();     // 当前未确认排表
ev.getRoundObjectives();   // 每轮三项目标值（诊断/测试用）
ev.getConfirmedByeCounts();// 已确认轮空累计
```

## 规则与目标

- 两人至少有一个共同兴趣标签才能配对；同一场活动内不重复配对。
- 每轮每人最多一组；到场未配对记一次轮空，缺席不记。
- 每轮严格按字典序优化三项目标（后一目标不补偿前一目标）：
  1. 配对组数最多；
  2. 本轮结束后所有参与者累计轮空次数的平方之和最小；
  3. 本轮所有配对的共同标签数量之和最大。
- 逐轮贪心：不为后续轮次牺牲当前轮目标；已确认轮次不可修改。

## 实现要点

- 三项目标按充分大的权值间隔编码为单条整数边权
  （`W1 * 1 + W2 * (p_i + p_j) + commonTags`，其中
  `p_i = 2 * 累计轮空 + 1`：轮空平方和展开后，未配对者的增量为线性项，
  因而可精确并入边权），再用**精确**一般图最大权匹配
  （Edmonds 开花算法，最大基数 + 最大权）求解，任何规模都不退化为近似。
- 兴趣标签编码为 64 位位掩码（两个 32 位半区），共同标签数用
  popcount 计算，构造时预计算全部配对的共同标签矩阵。
- 规模：300 名参与者、64 种标签、12 轮。实测完整生成 12 轮
  稠密图约 0.6 秒（上限 15 秒），峰值内存约 170 MiB（上限 256 MiB）。

## 测试

- `test/matching.test.ts`：开花算法与暴力枚举在 300 组随机小图上对拍。
- `test/event.test.ts`：每轮三项目标值与全部合法配对方案的最优值
  逐一对比（含三人互相可配、局部高分降低总组数、公平性与兴趣分冲突
  场景）；确认两轮后多次修改未来到场名单重排，校验已确认结果不变、
  未来无重复会面、轮空计数仅来自确认历史与当前排表。
- `test/scale.test.ts`：300 人 × 64 标签 × 12 轮的稠密与稀疏规模测试，
  校验结构约束与耗时。
