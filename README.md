# firewall-policy

进程内防火墙策略判定库（TypeScript），数据仅保存在内存中，由上层直接调用。

## 构建与测试

```sh
npm install
npm test
```

## 使用

```ts
import { Firewall } from "firewall-policy";

const firewall = new Firewall();
firewall.loadPolicies([
  {
    sourceZone: "dmz",
    destinationZone: "core",
    rules: [
      {
        priority: 10, // 同一策略内唯一，数字越小越先执行
        sourceCidr: "10.1.0.0/16",
        destinationCidr: "192.168.0.0/16",
        protocol: "TCP", // "TCP" | "UDP" | "ICMP"，精确匹配
        sourcePorts: { start: 1024, end: 65535 }, // 闭区间，ICMP 规则省略
        destinationPorts: { start: 443, end: 443 },
        timeWindows: [{ start: 0, end: 7200 }], // UTC 周内分钟，左闭右开；空列表 = 全周
        action: "ALLOW", // "ALLOW" | "DENY" | "RATE_LIMIT"
      },
    ],
  },
]);

const decision = firewall.evaluate({
  sourceZone: "dmz",
  destinationZone: "core",
  sourceAddress: "10.1.2.3",
  destinationAddress: "192.168.4.5",
  protocol: "TCP",
  sourcePort: 50000,
  destinationPort: 443,
  minuteOfWeek: 600,
});
// decision: "ALLOW" | "DENY" | "RATE_LIMIT"
```

## 语义

- 只处理跨网段流量；源、目标网段标识相同的报文直接默认拒绝。
- 每个有向网段对最多绑定一个策略，反向流量使用另一策略；方向无策略时默认拒绝。
- 规则需同时满足地址、协议、端口（仅 TCP/UDP）与时段条件才算匹配；
  在完整匹配的规则中取优先级数字最小者，返回其动作。
- 无前缀长短、端口范围大小或动作类型的额外排序；`RATE_LIMIT` 仅返回动作，不执行计量。
- 无任何完整匹配规则时默认拒绝。
