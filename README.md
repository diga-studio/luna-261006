# OT 攻击路径分析库

由上层应用直接调用的 TypeScript 库：提交完整 OT 拓扑后，查询从入口资产到目标资产的前十条最高风险攻击路径。

## 构建与测试

```sh
npm install
npm test        # 编译并运行全部测试
npm run build   # 仅编译到 dist/
```

## 使用

```ts
import { findTopAttackPaths, Protocol, Topology } from "ot-attack-path-analysis";

const topology: Topology = {
  assets: [
    { id: 1, purdueLevel: 0, criticality: 1 },
    { id: 2, purdueLevel: 4, criticality: 9 },
  ],
  connections: [
    { id: 10, from: 1, to: 2, protocol: Protocol.ModbusTcp, bidirectional: false },
  ],
};

const paths = findTopAttackPaths(topology, 1, 2);
// => [{ connectionIds: [10], score: 104 }]  （6 + 8 跨区 + 9*10）
```

## 规则

- 路径沿连接允许方向行进（双向连接任一方向均可，编号不变），最多 12 条连接，资产不重复，到达目标即结束。
- 协议权重：Modbus TCP = 6，DNP3 = 4，OPC-UA = 1；连接两端层级不同每次 +8；目标关键程度 ×10。
- 路径以完整连接编号序列区分；同一对资产间的平行连接形成不同路径。
- 排序：分数降序 → 连接数升序 → 连接编号序列数字字典序升序；返回前十条，不可达返回空数组。
