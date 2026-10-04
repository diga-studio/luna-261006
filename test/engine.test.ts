import { test } from "node:test";
import assert from "node:assert/strict";
import { PolicyEngine, type Packet, type Rule } from "../src/index.js";

function rule(partial: Partial<Rule> & { id: string }): Rule {
  return {
    sourceCidr: "10.0.0.0/24",
    destinationCidr: "172.16.0.0/24",
    protocol: "TCP",
    portStart: 1,
    portEnd: 65535,
    action: "allow",
    priority: 10,
    ...partial,
  };
}

test("初始策略为空，默认拒绝", () => {
  const engine = new PolicyEngine();
  assert.deepEqual(engine.getEffectiveRules(), []);
  assert.deepEqual(
    engine.evaluate({
      sourceAddress: "10.0.0.1",
      destinationAddress: "172.16.0.1",
      protocol: "TCP",
      destinationPort: 80,
    }),
    { kind: "default-deny" },
  );
});

test("相反动作同级重叠，被多条高优先级规则联合完全遮蔽时允许发布", () => {
  const engine = new PolicyEngine();
  const rules: Rule[] = [
    // 同级相反动作，重叠区为端口 150-200。
    rule({ id: "allow-wide", portStart: 100, portEnd: 200, action: "allow" }),
    rule({ id: "deny-wide", portStart: 150, portEnd: 250, action: "deny" }),
    // 两条高优先级规则联合覆盖 150-200。
    rule({ id: "hi-1", portStart: 150, portEnd: 180, action: "deny", priority: 5 }),
    rule({ id: "hi-2", portStart: 181, portEnd: 200, action: "allow", priority: 5 }),
  ];
  const result = engine.replacePolicy(rules);
  assert.deepEqual(result, { ok: true });
  assert.equal(engine.getEffectiveRules().length, 4);
  // 重叠区按高优先级规则判定。
  assert.deepEqual(
    engine.evaluate({
      sourceAddress: "10.0.0.9",
      destinationAddress: "172.16.0.9",
      protocol: "TCP",
      destinationPort: 160,
    }),
    { kind: "action", action: "deny", priority: 5, matchedRuleIds: ["hi-1"] },
  );
});

test("仅留下一个地址组合上的单个端口缺口时拒绝发布，见证准确且原策略不变", () => {
  const engine = new PolicyEngine();
  const baseline: Rule[] = [
    rule({ id: "baseline", action: "allow", portStart: 1, portEnd: 65535 }),
  ];
  assert.deepEqual(engine.replacePolicy(baseline), { ok: true });

  const candidate: Rule[] = [
    rule({ id: "allow-wide", portStart: 100, portEnd: 200, action: "allow" }),
    rule({ id: "deny-wide", portStart: 150, portEnd: 250, action: "deny" }),
    // 高优先级联合覆盖 150-199，唯独漏掉端口 200。
    rule({ id: "hi-1", portStart: 150, portEnd: 180, action: "deny", priority: 5 }),
    rule({ id: "hi-2", portStart: 181, portEnd: 199, action: "allow", priority: 5 }),
  ];
  const result = engine.replacePolicy(candidate);
  assert.equal(result.ok, false);
  const witness: Packet = (result as { ok: false; witness: Packet }).witness;
  assert.deepEqual(witness, {
    sourceAddress: "10.0.0.0",
    destinationAddress: "172.16.0.0",
    protocol: "TCP",
    destinationPort: 200,
  });
  // 原策略保持不变。
  assert.deepEqual(engine.getEffectiveRules(), baseline);
  const decision = engine.evaluate({
    sourceAddress: "10.0.0.1",
    destinationAddress: "172.16.0.1",
    protocol: "TCP",
    destinationPort: 200,
  });
  assert.deepEqual(decision, {
    kind: "action",
    action: "allow",
    priority: 10,
    matchedRuleIds: ["baseline"],
  });
});

test("不同优先级的相反动作是有意覆盖，不算冲突", () => {
  const engine = new PolicyEngine();
  const result = engine.replacePolicy([
    rule({ id: "deny-low", action: "deny", priority: 20 }),
    rule({ id: "allow-high", action: "allow", priority: 5, portStart: 80, portEnd: 80 }),
  ]);
  assert.deepEqual(result, { ok: true });
});

test("未被更高优先级遮蔽的同级相反动作构成冲突", () => {
  const engine = new PolicyEngine();
  const result = engine.replacePolicy([
    rule({ id: "a", action: "allow", portStart: 1, portEnd: 100 }),
    rule({ id: "b", action: "deny", portStart: 50, portEnd: 150 }),
  ]);
  assert.equal(result.ok, false);
  const witness = (result as { ok: false; witness: Packet }).witness;
  assert.equal(witness.destinationPort, 50);
});

test("输入规则顺序不影响判定结果", () => {
  const rules: Rule[] = [
    rule({ id: "allow-wide", portStart: 100, portEnd: 200, action: "allow" }),
    rule({ id: "deny-wide", portStart: 150, portEnd: 250, action: "deny" }),
    rule({ id: "hi-1", portStart: 150, portEnd: 200, action: "deny", priority: 5 }),
  ];
  const forward = new PolicyEngine().replacePolicy(rules);
  const reversed = new PolicyEngine().replacePolicy([...rules].reverse());
  assert.deepEqual(forward, { ok: true });
  assert.deepEqual(reversed, { ok: true });
});

test("未投入使用的地址同样参与冲突判断（/0 与 /32）", () => {
  const engine = new PolicyEngine();
  const result = engine.replacePolicy([
    rule({
      id: "allow-all",
      sourceCidr: "0.0.0.0/0",
      destinationCidr: "0.0.0.0/0",
      action: "allow",
      portStart: 1,
      portEnd: 65535,
    }),
    rule({
      id: "deny-one-asset",
      sourceCidr: "0.0.0.0/0",
      destinationCidr: "203.0.113.7/32",
      action: "deny",
      portStart: 443,
      portEnd: 443,
    }),
  ]);
  assert.equal(result.ok, false);
  const witness = (result as { ok: false; witness: Packet }).witness;
  assert.equal(witness.destinationAddress, "203.0.113.7");
  assert.equal(witness.destinationPort, 443);
});

test("协议与端口维度参与命中判断", () => {
  const engine = new PolicyEngine();
  // 同区域 TCP allow 与 UDP deny 协议不同，不冲突。
  const result = engine.replacePolicy([
    rule({ id: "tcp-allow", protocol: "TCP", action: "allow" }),
    rule({ id: "udp-deny", protocol: "UDP", action: "deny" }),
  ]);
  assert.deepEqual(result, { ok: true });
});

test("空候选策略可以发布，清空现有策略", () => {
  const engine = new PolicyEngine();
  engine.replacePolicy([rule({ id: "x" })]);
  assert.deepEqual(engine.replacePolicy([]), { ok: true });
  assert.deepEqual(engine.getEffectiveRules(), []);
});

test("非法规则被拒绝", () => {
  const engine = new PolicyEngine();
  assert.throws(() =>
    engine.replacePolicy([rule({ id: "bad", portStart: 0 })]),
  );
  assert.throws(() =>
    engine.replacePolicy([rule({ id: "bad", portEnd: 65536 })]),
  );
  assert.throws(() =>
    engine.replacePolicy([
      rule({ id: "dup" }),
      rule({ id: "dup", action: "deny" }),
    ]),
  );
  assert.throws(() =>
    engine.replacePolicy([rule({ id: "bad", sourceCidr: "10.0.0.0/33" })]),
  );
});
