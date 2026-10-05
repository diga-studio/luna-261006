# NurtureTrack 行为观察区间统计库

供 NurtureTrack 进度报告调用的 TypeScript 库：对一名学生的一项行为，
在固定长度的累计有效观察时间轴上汇总整段记录、部分记录、瞬时采样三种评估方法的结果。
纯内存实现，不跨运行保留数据，无接口层。

## 构建与测试

```sh
npm install
npm test
```

## 使用

```ts
import { BehaviorTimeline } from "./src";

// 时间轴总长必须是 10000ms 的正整数倍
const timeline = new BehaviorTimeline(30_000);

// 提交记录（左闭右开）；再次提交同一 id 即完整替换
timeline.submit({ id: "rec-1", startMs: 0, endMs: 10_000, occurred: true });
timeline.submit({ id: "rec-2", startMs: 5_000, endMs: 15_000, occurred: false });

// 撤销记录（只移除指定记录，不影响其他记录支持的结论）
timeline.retract("rec-2");

// 按完整区间下标报告 [fromInterval, toInterval)
const report = timeline.report(0, 3);
// report.wholeInterval / report.partialInterval / report.momentarySampling
// 各自包含 { occurred, notOccurred, unknown, occurredRatio }
// occurredRatio 仅以发生+未发生区间数为分母，无可判定区间时为 null
```

## 判定规则

- 某时刻只有“发生”记录覆盖 → 确定发生；只有“未发生”记录覆盖 → 确定未发生；
  两类同时覆盖或均无覆盖 → 未知。同类重叠不增加权重。
- 整段记录法：区间全部时刻确定发生 → 发生；任一时刻确定未发生 → 未发生；其余未知。
- 部分记录法：任一时刻确定发生 → 发生；全部时刻确定未发生 → 未发生；其余未知。
- 瞬时采样：取区间开始后 5000ms 的时刻结论；采样点等于记录右端点时该记录不覆盖。
