# 厂区维护窗口推荐库

由上层直接调用的 TypeScript 库：一次处理一个厂区，把劣化预测给出的设备检修需求
安排到厂区允许停机的候选时点，输出覆盖全部设备、总停产费用全局最低的可执行计划。
输入与计算结果只保留在内存中，无任何持久化与外部服务依赖。

## 使用

```ts
import { planMaintenance } from 'plant-maintenance-planner';

const result = planMaintenance({
  devices: [
    { id: 'EQ1', windowStart: 0, windowEnd: 24, duration: 3, resourceIds: ['R1', 'R2'] },
    { id: 'EQ2', windowStart: 0, windowEnd: 24, duration: 2, resourceIds: ['R2'] },
  ],
  candidateSlots: [0, 8, 16],
});

if (result.feasible) {
  // result.groups: 每组的设备、开始时点、所选隔离资源、停机时长
  // result.totalDowntimeHours / result.totalCost（每小时 15,000 美元）
} else {
  // 无法覆盖全部设备
}
```

## 规则摘要

- 每台设备：唯一编号、可检修区间（≤48 小时，两端含）、检修时长（1~8 小时）、可用隔离资源集合；时刻均为整点。
- 只能从候选停机开始时点中选择（相邻至少相隔 8 小时），每个时点最多一个维护组，可空置。
- 每个维护组 1~3 台设备，同组同时开始，且必须存在整组共同可用的隔离资源（两两共用不算）。
- 组停机时长 = 组内最长检修时长；总费用 = 各组停机时长之和 × 15,000 美元/小时。
- 费用达到全局最小；无法覆盖全部设备时返回 `feasible: false`。
- 设备与时点的输入顺序不影响最优费用与可行性结论。

## 求解方法

精确动态规划：状态为（待覆盖设备集合位掩码, 当前候选时点），每个时点选择空置，
或安排一个包含最低位未覆盖设备的可行维护组（1~3 台、有共同资源、全员区间可容纳）。
18 台设备 / 10 个时点 / 8 种资源的最坏规模下，单次规划约几十毫秒、内存远低于 256 MiB。

## 构建与测试

```sh
npm install
npm test        # 先 tsc 构建，再运行 node:test 测试
```

仅依赖 `typescript` 与 `@types/node`（devDependencies），干净机器上 `npm install` 后即可运行。
