import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import { PolicyEngine, type Rule } from "../src/index";

function rule(partial: Partial<Rule> & Pick<Rule, "id">): Rule {
  return {
    sourceCidr: "10.0.0.0/24",
    destCidr: "10.0.1.0/24",
    protocol: "TCP",
    portStart: 1,
    portEnd: 65535,
    action: "allow",
    priority: 10,
    ...partial,
  };
}

test("empty policy evaluates to default deny", () => {
  const engine = new PolicyEngine();
  deepEqual(engine.getRules(), []);
  equal(
    engine.evaluate({
      sourceAddress: "10.0.0.1",
      destAddress: "10.0.1.1",
      protocol: "TCP",
      destPort: 80,
    }),
    "deny"
  );
});

test("same-priority opposite actions fully shadowed by multiple higher-priority rules can publish", () => {
  const engine = new PolicyEngine();
  const rules: Rule[] = [
    rule({ id: "allow-all", action: "allow", priority: 10 }),
    rule({ id: "deny-all", action: "deny", priority: 10 }),
    rule({ id: "shadow-low-ports", portStart: 1, portEnd: 32768, priority: 5 }),
    rule({
      id: "shadow-high-ports",
      portStart: 32769,
      portEnd: 65535,
      priority: 5,
    }),
  ];
  const result = engine.replacePolicy(rules);
  deepEqual(result, { ok: true });
  equal(engine.getRules().length, 4);
  equal(
    engine.evaluate({
      sourceAddress: "10.0.0.9",
      destAddress: "10.0.1.9",
      protocol: "TCP",
      destPort: 443,
    }),
    "allow"
  );
});

test("single-port gap on one address pair rejects publish with exact witness and keeps old policy", () => {
  const engine = new PolicyEngine();
  const baseline: Rule[] = [
    rule({ id: "baseline", action: "allow", priority: 1, portStart: 80, portEnd: 80 }),
  ];
  deepEqual(engine.replacePolicy(baseline), { ok: true });

  const candidate: Rule[] = [
    rule({
      id: "allow-box",
      action: "allow",
      priority: 10,
      sourceCidr: "10.0.0.0/31",
      destCidr: "10.0.1.0/31",
      portStart: 1,
      portEnd: 2,
    }),
    rule({
      id: "deny-box",
      action: "deny",
      priority: 10,
      sourceCidr: "10.0.0.0/31",
      destCidr: "10.0.1.0/31",
      portStart: 1,
      portEnd: 2,
    }),
    rule({
      id: "shadow-src0",
      priority: 5,
      sourceCidr: "10.0.0.0/32",
      destCidr: "10.0.1.0/31",
      portStart: 1,
      portEnd: 2,
    }),
    rule({
      id: "shadow-dst0",
      priority: 5,
      sourceCidr: "10.0.0.1/32",
      destCidr: "10.0.1.0/32",
      portStart: 1,
      portEnd: 2,
    }),
    rule({
      id: "shadow-port1",
      priority: 5,
      sourceCidr: "10.0.0.1/32",
      destCidr: "10.0.1.1/32",
      portStart: 1,
      portEnd: 1,
    }),
  ];
  const result = engine.replacePolicy(candidate);
  equal(result.ok, false);
  if (!result.ok) {
    deepEqual(result.witness, {
      sourceAddress: "10.0.0.1",
      destAddress: "10.0.1.1",
      protocol: "TCP",
      destPort: 2,
    });
  }
  deepEqual(engine.getRules(), baseline);
});

test("opposite actions at different priorities are intentional overrides, not conflicts", () => {
  const engine = new PolicyEngine();
  const rules: Rule[] = [
    rule({ id: "deny-subnet", action: "deny", priority: 20 }),
    rule({
      id: "allow-asset",
      action: "allow",
      priority: 5,
      sourceCidr: "10.0.0.7/32",
      destCidr: "10.0.1.7/32",
      portStart: 443,
      portEnd: 443,
    }),
  ];
  deepEqual(engine.replacePolicy(rules), { ok: true });
  equal(
    engine.evaluate({
      sourceAddress: "10.0.0.7",
      destAddress: "10.0.1.7",
      protocol: "TCP",
      destPort: 443,
    }),
    "allow"
  );
  equal(
    engine.evaluate({
      sourceAddress: "10.0.0.8",
      destAddress: "10.0.1.8",
      protocol: "TCP",
      destPort: 443,
    }),
    "deny"
  );
});

test("rule order does not affect the publish decision", () => {
  const rules: Rule[] = [
    rule({ id: "a", action: "allow", priority: 10 }),
    rule({ id: "b", action: "deny", priority: 10 }),
    rule({ id: "c", priority: 5, portStart: 1, portEnd: 40000 }),
    rule({ id: "d", priority: 5, portStart: 40001, portEnd: 65535 }),
  ];
  const reversed = [...rules].reverse();
  deepEqual(new PolicyEngine().replacePolicy(rules), { ok: true });
  deepEqual(new PolicyEngine().replacePolicy(reversed), { ok: true });
});

test("shadowing only counts within the same protocol", () => {
  const engine = new PolicyEngine();
  const rules: Rule[] = [
    rule({ id: "udp-allow", protocol: "UDP", action: "allow", priority: 10 }),
    rule({ id: "udp-deny", protocol: "UDP", action: "deny", priority: 10 }),
    rule({ id: "tcp-shadow", protocol: "TCP", priority: 5 }),
  ];
  const result = engine.replacePolicy(rules);
  equal(result.ok, false);
  if (!result.ok) {
    equal(result.witness.protocol, "UDP");
  }
});

test("zero-length prefix covers the whole IPv4 space", () => {
  const engine = new PolicyEngine();
  const rules: Rule[] = [
    rule({
      id: "any-to-any",
      protocol: "UDP",
      sourceCidr: "0.0.0.0/0",
      destCidr: "0.0.0.0/0",
      action: "allow",
      priority: 1,
    }),
  ];
  deepEqual(engine.replacePolicy(rules), { ok: true });
  equal(
    engine.evaluate({
      sourceAddress: "203.0.113.9",
      destAddress: "198.51.100.4",
      protocol: "UDP",
      destPort: 65535,
    }),
    "allow"
  );
});

test("conflict on unregistered addresses still rejects publish", () => {
  const engine = new PolicyEngine();
  const rules: Rule[] = [
    rule({
      id: "allow-quiet",
      action: "allow",
      priority: 10,
      sourceCidr: "192.0.2.0/24",
      destCidr: "198.51.100.0/24",
    }),
    rule({
      id: "deny-quiet",
      action: "deny",
      priority: 10,
      sourceCidr: "192.0.2.0/24",
      destCidr: "198.51.100.0/24",
    }),
  ];
  const result = engine.replacePolicy(rules);
  equal(result.ok, false);
  if (!result.ok) {
    ok(result.witness.sourceAddress.startsWith("192.0.2."));
    ok(result.witness.destAddress.startsWith("198.51.100."));
  }
});
