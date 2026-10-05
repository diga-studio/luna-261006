# NovaSphere 主机维护疏散规划库

纯内存的疏散规划库：给定集群主机、当前 VM 分布与唯一待维护主机，
计算把该主机上全部 VM 迁出的**最优迁移计划**。库只做规划，不实际控制 VM；
输入与结果仅存在于进程内存中。

## 使用

```ts
import { planEvacuation } from "novasphere-evacuation-planner";

const result = planEvacuation({
  hosts: [
    { id: "A", arch: "x86", cpuBudget: 8, memoryBudgetMib: 1024 },
    { id: "B", arch: "x86", cpuBudget: 8, memoryBudgetMib: 1024 },
  ],
  vms: [{ id: "vm-1", arch: "x86", cpu: 2, memoryMib: 256 }],
  placement: { "vm-1": "A" },
  maintenanceHostId: "A",
});

if (result.status === "planned") {
  // result.plan.migrations: 按顺序执行的迁移步骤
  // result.plan.totalMigratedMemoryMib: 累计迁移内存（同一 VM 多次迁移逐次累加）
} else {
  // result.status === "no-solution": 确定无解（搜索已穷尽，非贪心失败）
}
```

## 语义

- 最优性：先使迁移次数最少，次数相同时使累计迁移内存最少。
- 迁移严格顺序执行；开始前目标主机必须同时有足够 CPU 与内存，
  源主机资源在迁移完成后才释放。
- 待维护主机从规划开始即不接受任何迁入；其他 VM 可迁移，
  同一 VM 可多次迁移以临时腾挪资源。
- VM 只能驻留在相同架构（x86/ARM）的主机上。
- 待维护主机本来为空时，最优计划为空计划。
- 规划不会修改输入对象。

## 实现

对 VM 放置状态空间做 Dijkstra 搜索，代价为字典序
`(迁移次数, 累计迁移内存)`。每次迁移代价为 `(1, vmMemoryMib)`，
因此首次弹出目标状态即为双目标最优；搜索穷尽才返回 `no-solution`，
保证完备性。

## 构建与测试

```sh
npm install
npm test
```

仅依赖 Node.js 与 `typescript`（devDependency），测试使用 Node 内置
`node:test` 运行器，无其他服务或工具要求。
