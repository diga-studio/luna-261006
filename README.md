# IronPerimeter 微隔离策略发布库

进程内存中的微隔离策略引擎，由上层直接调用。候选策略只有在所有可能的
数据包上都无歧义（冲突）时才允许整体替换生效策略；存在冲突时拒绝发布，
并返回一个可复核的冲突数据包见证，原策略保持不变。

## 构建与测试

```sh
npm install
npm test
```

## 规则模型

每条规则包含：唯一标识 `id`、源/目的规范化 IPv4 CIDR（单资产为 `/32`，
`/0` 覆盖整个 IPv4 空间）、协议（`TCP`/`UDP`）、目的端口闭区间
（1-65535）、动作（`allow`/`deny`）与优先级（数值越小越先匹配，允许同
级多条）。

数据包命中取最小优先级上的规则：动作全部相同则采用该动作；同级同时出现
allow 与 deny 才构成冲突；不同优先级的相反动作属于有意覆盖，不算冲突；
无命中默认拒绝。低优先级相反动作的重叠区若被更高优先级规则的并集完全覆
盖，允许发布；哪怕只剩一个地址组合上的一个端口未被覆盖，也会拒绝。

## 使用示例

```ts
import { PolicyEngine } from "iron-perimeter-policy";

const engine = new PolicyEngine(); // 初始策略为空，默认拒绝

const result = engine.replacePolicy([
  {
    id: "web-allow",
    sourceCidr: "10.0.0.0/8",
    destinationCidr: "192.168.1.10/32",
    protocol: "TCP",
    portStart: 443,
    portEnd: 443,
    action: "allow",
    priority: 10,
  },
]);

if (!result.ok) {
  console.error("冲突见证:", result.witness);
}

const decision = engine.evaluate({
  sourceAddress: "10.1.2.3",
  destinationAddress: "192.168.1.10",
  protocol: "TCP",
  destinationPort: 443,
});
```

## API

- `replacePolicy(rules)`：整体替换。返回 `{ ok: true }` 或
  `{ ok: false, witness }`；拒绝时原策略不变。
- `getEffectiveRules()`：当前生效策略的规则快照。
- `evaluate(packet)`：判定单个数据包，返回 `action` / `conflict` /
  `default-deny`。
