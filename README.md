# NurtureTrack 行为观察区间统计库

针对一名学生的一项行为，在固定长度的累计有效观察时间轴上管理观察记录，
并按整段记录、部分记录、瞬时采样三种方法生成区间统计报告。纯内存实现，不持久化。

## 构建与测试

```sh
npm install
npm test
```

## 使用

```ts
import { ObservationTimeline, buildReport } from "./src";

const timeline = new ObservationTimeline(30000); // 总长度须为 10000 的整数倍
timeline.submit({ id: "r1", startMs: 0, endMs: 10000, verdict: "occurred" });
timeline.submit({ id: "r2", startMs: 0, endMs: 10000, verdict: "occurred" });
timeline.revoke("r1"); // r2 仍支持"发生"结论

const report = buildReport(timeline, 0, 3); // 按完整区间指定 [from, to)
// report.whole / report.partial / report.momentary
// 各含 { occurred, notOccurred, unknown, occurredRatio }
```

## 判定规则

- 时刻判定：只有"发生"记录覆盖 → 确定发生；只有"未发生"记录覆盖 → 确定未发生；
  两类同时覆盖或均无覆盖 → 未知。记录范围左闭右开。
- 整段记录（whole）：整区间确定发生 → 发生；任一时刻确定未发生 → 未发生；否则未知。
- 部分记录（partial）：任一时刻确定发生 → 发生；整区间确定未发生 → 未发生；否则未知。
- 瞬时采样（momentary）：取区间开始后 5000ms 时刻的判定。
- 发生比例 = 发生区间数 / (发生 + 未发生区间数)；无可判定区间时为 `null`。
