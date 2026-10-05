# ot-attack-path-analysis

OT 攻击路径分析库：从远程接入设备出发，在 Purdue 分层拓扑中找出通往关键控制资产的前十条最高风险攻击路线。

## 使用

```ts
import { createAnalyzer } from "ot-attack-path-analysis";

const analyzer = createAnalyzer({
  assets: [{ id: 1, level: 4, criticality: 2 }, /* ... */],
  connections: [
    { id: 10, from: 1, to: 2, protocol: "Modbus TCP", bidirectional: false },
    // ...
  ],
});

const paths = analyzer.findTopPaths(entryId, targetId);
// => [{ connectionIds, assetIds, score }, ...] 最多十条，按风险从高到低
```

## 规则

- 协议权重：Modbus TCP = 6，DNP3 = 4，OPC-UA = 1。
- 路径分数 = 连接协议权重之和 + 每次跨区（连接两端层级不同）8 分 + 目标关键程度 × 10。
- 有效路径：沿连接允许方向行进（双向连接可任一方向），最多 12 条连接，资产不重复，到达目标即结束。
- 路径以完整连接编号序列区分；同一对资产间的平行连接形成不同路径。
- 排序：分数降序 → 连接数升序 → 连接编号序列数字字典序升序。不足十条全部返回，不可达返回空数组。

## 开发

```sh
npm install
npm test   # 编译并运行全部测试
npm run build
```
