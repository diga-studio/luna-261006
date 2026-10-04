# license-seat-rebalance

软件许可席位重排库（TypeScript，纯内存计算）。每次接收同一款软件的完整盘点快照，
重新核算设备与许可池的绑定关系。

## 目标

1. 使获得有效授权的设备总数最大；
2. 在覆盖数最大的所有方案中，使保持原许可池绑定的设备数最多（原先无绑定的设备不计入）。

许可不足时返回最优的部分覆盖方案，不会整批失败。

## 规则

- 一台设备需要 1 席，最多绑定一个许可池，且其当前部门必须在池的允许范围内；
- 每个许可池的绑定设备数不超过席位总数；
- 池在到期日当天仍有效，早于核算日（`businessDate`）的池不参与分配；
- 原绑定仅是上一轮结果，可能因到期、缩容或部门范围变化而失效。

## 用法

```ts
import { rebalance } from "./src";

const result = rebalance({
  businessDate: "2026-06-01",
  devices: [
    { id: "dev-1", department: "甲", previousPoolId: "P1" },
    { id: "dev-2", department: "乙" },
  ],
  pools: [
    { id: "P1", totalSeats: 1, expiresAt: "2026-12-31", allowedDepartments: ["甲", "乙"] },
    { id: "P2", totalSeats: 1, expiresAt: "2026-12-31", allowedDepartments: ["甲"] },
  ],
});
// result.assignments        -> [{ deviceId, poolId }, ...]
// result.uncoveredDeviceIds -> 未覆盖的设备 id 列表
```

## 实现

建模为最小费用最大流（`src/solver.ts`）：源点到每台设备容量 1；设备到可用许可池
容量 1，保留原绑定的边费用 0、新绑定费用 1；池到汇点容量为席位数。最大流保证覆盖
数最大，同流量下最小费用保证保留原绑定最多。

## 构建与测试

```sh
npm install
npm test
```
