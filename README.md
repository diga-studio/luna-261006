# plant-maintenance-planner

厂区维护窗口推荐库。一次处理一个厂区：在厂区给定的候选停机开始时点中，
把每台设备的检修安排进维护组（1-3 台设备、共用一种停机隔离资源），
输出覆盖全部设备、总停产费用全局最低的可执行计划。
输入与计算结果仅保留在内存中，无任何持久化与外部依赖。

## 安装与测试

```sh
npm install
npm test        # 编译 TypeScript 并运行全部自动化测试
npm run build   # 仅编译到 dist/
```

## 使用

```ts
import { planMaintenance } from "plant-maintenance-planner";

const result = planMaintenance({
  devices: [
    {
      id: "PUMP-01",
      windowStart: 0,      // 可检修区间下界（含），整点
      windowEnd: 24,       // 可检修区间上界（含），区间最长 48 小时
      duration: 4,         // 检修时长 1-8 小时
      resourceIds: ["ISO-A", "ISO-B"],
    },
    // ...最多 18 台设备
  ],
  candidateStarts: [0, 8, 16, 24], // 候选停机开始时点，最多 10 个，相邻至少相隔 8 小时
});

if (result.feasible) {
  for (const group of result.groups) {
    // group.deviceIds / group.start / group.resourceId / group.duration
  }
  // result.totalDowntimeHours / result.totalCost（每小时 15,000 美元）
} else {
  // 无法覆盖全部设备
}
```

## 规则摘要

- 每个候选时点最多安排一个维护组，也可空置；不能新增或移动时点。
- 每组 1-3 台设备，同组同时开始，且整组必须存在共同可用的隔离资源
  （两两有共用资源不代表三者有共同资源）。
- 每台设备的开始与完成时刻都必须落在自己的可检修区间内（两端含）。
- 组停机时长 = 组内最长检修时长；总费用 = 总停机时长 × 15,000 美元/小时。
- 费用达到全局最小；费用相同时返回任意最优方案；无法覆盖全部设备时
  `feasible` 为 `false`。
- 结果与设备、候选时点的输入顺序无关。

## 规模与性能

单次输入最多 18 台设备、10 个候选时点、8 种隔离资源。
求解器按候选时点做位掩码动态规划（状态数 10 × 2^18），
在最坏情形下远低于 10 秒 / 256 MiB 的限制（实测约 0.3 秒）。

非法输入（设备数超限、区间超 48 小时、时点间隔不足 8 小时等）抛出
`ValidationError`。
