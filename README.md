# iron-perimeter-policy

IronPerimeter 微隔离策略发布库（TypeScript）。候选策略与已生效策略均保存在进程内存中，由上层直接调用。

## 使用

```ts
import { PolicyEngine } from "iron-perimeter-policy";

const engine = new PolicyEngine(); // 初始策略为空，默认拒绝

const result = engine.replacePolicy([
  {
    id: "allow-web",
    sourceCidr: "10.0.0.0/24",
    destCidr: "10.0.1.7/32",
    protocol: "TCP",
    portStart: 443,
    portEnd: 443,
    action: "allow",
    priority: 10,
  },
]);

if (!result.ok) {
  // 发布被拒绝，result.witness 是一个可复核的冲突数据包，原策略保持不变
  console.error(result.witness);
}

engine.evaluate({
  sourceAddress: "10.0.0.9",
  destAddress: "10.0.1.7",
  protocol: "TCP",
  destPort: 443,
}); // "allow" | "deny"
```

## 语义

- 规则：唯一 id、源/目的 IPv4 CIDR（/0 至 /32）、协议（TCP/UDP）、目的端口闭区间（1-65535）、动作（allow/deny）、优先级（数值小者先匹配，允许同级）。
- 数据包命中：源、目的地址分别落入 CIDR（含网络地址与广播地址），协议相同且端口落入区间。
- 判定：取命中的最小优先级，该级动作全部相同则采用；同级同时存在 allow 与 deny 才构成冲突；无命中默认拒绝。
- 发布：候选策略须在所有可能数据包上无冲突（含未登记资产、无流量地址）。同级相反动作的重叠区若被更高优先级规则的并集完全遮蔽，允许发布；否则拒绝并返回一个冲突数据包见证，原策略不变。

## 构建与测试

```sh
npm install
npm test
```
