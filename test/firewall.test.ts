import test from "node:test";
import assert from "node:assert/strict";
import { Firewall, Packet, Policy, Rule } from "../src/index";

function makeRule(overrides: Partial<Rule> & { priority: number }): Rule {
  return {
    sourceCidr: "0.0.0.0/0",
    destinationCidr: "0.0.0.0/0",
    protocol: "TCP",
    sourcePorts: { start: 0, end: 65535 },
    destinationPorts: { start: 0, end: 65535 },
    timeWindows: [],
    action: "ALLOW",
    ...overrides,
  };
}

function makePacket(overrides: Partial<Packet> = {}): Packet {
  return {
    sourceZone: "dmz",
    destinationZone: "core",
    sourceAddress: "10.1.2.3",
    destinationAddress: "192.168.4.5",
    protocol: "TCP",
    sourcePort: 50000,
    destinationPort: 443,
    minuteOfWeek: 600,
    ...overrides,
  };
}

function firewallWith(policies: Policy[]): Firewall {
  const firewall = new Firewall();
  firewall.loadPolicies(policies);
  return firewall;
}

test("multiple matching rules: smallest priority number wins regardless of action", () => {
  const firewall = firewallWith([
    {
      sourceZone: "dmz",
      destinationZone: "core",
      rules: [
        makeRule({ priority: 30, action: "ALLOW" }),
        makeRule({ priority: 10, action: "RATE_LIMIT" }),
        makeRule({ priority: 20, action: "DENY" }),
      ],
    },
  ]);
  assert.equal(firewall.evaluate(makePacket()), "RATE_LIMIT");
});

test("most specific CIDR does not outrank priority", () => {
  const firewall = firewallWith([
    {
      sourceZone: "dmz",
      destinationZone: "core",
      rules: [
        makeRule({
          priority: 5,
          sourceCidr: "10.0.0.0/8",
          destinationCidr: "192.168.0.0/16",
          action: "RATE_LIMIT",
        }),
        makeRule({
          priority: 9,
          sourceCidr: "10.1.2.0/24",
          destinationCidr: "192.168.4.0/24",
          action: "ALLOW",
        }),
      ],
    },
  ]);
  assert.equal(firewall.evaluate(makePacket()), "RATE_LIMIT");
});

test("higher-priority rule failing only on ports falls through to next match", () => {
  const firewall = firewallWith([
    {
      sourceZone: "dmz",
      destinationZone: "core",
      rules: [
        makeRule({
          priority: 1,
          destinationPorts: { start: 80, end: 80 },
          action: "DENY",
        }),
        makeRule({ priority: 2, action: "ALLOW" }),
      ],
    },
  ]);
  assert.equal(firewall.evaluate(makePacket({ destinationPort: 443 })), "ALLOW");
  assert.equal(firewall.evaluate(makePacket({ destinationPort: 80 })), "DENY");
});

test("higher-priority rule failing only on time window falls through to next match", () => {
  const firewall = firewallWith([
    {
      sourceZone: "dmz",
      destinationZone: "core",
      rules: [
        makeRule({
          priority: 1,
          timeWindows: [{ start: 0, end: 60 }],
          action: "DENY",
        }),
        makeRule({ priority: 2, action: "ALLOW" }),
      ],
    },
  ]);
  assert.equal(firewall.evaluate(makePacket({ minuteOfWeek: 600 })), "ALLOW");
  assert.equal(firewall.evaluate(makePacket({ minuteOfWeek: 30 })), "DENY");
});

test("time windows: left-closed right-open, multiple intervals, empty means all week", () => {
  const rule = makeRule({
    priority: 1,
    timeWindows: [
      { start: 120, end: 240 },
      { start: 10000, end: 10080 },
    ],
    action: "ALLOW",
  });
  const firewall = firewallWith([
    { sourceZone: "dmz", destinationZone: "core", rules: [rule] },
  ]);
  assert.equal(firewall.evaluate(makePacket({ minuteOfWeek: 119 })), "DENY");
  assert.equal(firewall.evaluate(makePacket({ minuteOfWeek: 120 })), "ALLOW");
  assert.equal(firewall.evaluate(makePacket({ minuteOfWeek: 239 })), "ALLOW");
  assert.equal(firewall.evaluate(makePacket({ minuteOfWeek: 240 })), "DENY");
  assert.equal(firewall.evaluate(makePacket({ minuteOfWeek: 10079 })), "ALLOW");
  assert.equal(firewall.evaluate(makePacket({ minuteOfWeek: 5000 })), "DENY");

  const allWeek = firewallWith([
    {
      sourceZone: "dmz",
      destinationZone: "core",
      rules: [makeRule({ priority: 1, timeWindows: [], action: "ALLOW" })],
    },
  ]);
  assert.equal(allWeek.evaluate(makePacket({ minuteOfWeek: 0 })), "ALLOW");
  assert.equal(allWeek.evaluate(makePacket({ minuteOfWeek: 10079 })), "ALLOW");
});

test("port range endpoints are inclusive", () => {
  const firewall = firewallWith([
    {
      sourceZone: "dmz",
      destinationZone: "core",
      rules: [
        makeRule({
          priority: 1,
          sourcePorts: { start: 50000, end: 50010 },
          destinationPorts: { start: 443, end: 444 },
          action: "ALLOW",
        }),
      ],
    },
  ]);
  assert.equal(
    firewall.evaluate(makePacket({ sourcePort: 50000, destinationPort: 443 })),
    "ALLOW",
  );
  assert.equal(
    firewall.evaluate(makePacket({ sourcePort: 50010, destinationPort: 444 })),
    "ALLOW",
  );
  assert.equal(
    firewall.evaluate(makePacket({ sourcePort: 50011, destinationPort: 443 })),
    "DENY",
  );
  assert.equal(
    firewall.evaluate(makePacket({ sourcePort: 50000, destinationPort: 445 })),
    "DENY",
  );
});

test("protocol must match exactly; ICMP rules ignore ports", () => {
  const firewall = firewallWith([
    {
      sourceZone: "dmz",
      destinationZone: "core",
      rules: [
        makeRule({
          priority: 1,
          protocol: "ICMP",
          sourcePorts: undefined,
          destinationPorts: undefined,
          action: "ALLOW",
        }),
      ],
    },
  ]);
  assert.equal(
    firewall.evaluate(
      makePacket({
        protocol: "ICMP",
        sourcePort: undefined,
        destinationPort: undefined,
      }),
    ),
    "ALLOW",
  );
  assert.equal(firewall.evaluate(makePacket({ protocol: "TCP" })), "DENY");
  assert.equal(firewall.evaluate(makePacket({ protocol: "UDP" })), "DENY");
});

test("CIDR edge prefix lengths /0 and /32", () => {
  const firewall = firewallWith([
    {
      sourceZone: "dmz",
      destinationZone: "core",
      rules: [
        makeRule({
          priority: 1,
          sourceCidr: "10.1.2.3/32",
          destinationCidr: "0.0.0.0/0",
          action: "ALLOW",
        }),
      ],
    },
  ]);
  assert.equal(firewall.evaluate(makePacket()), "ALLOW");
  assert.equal(
    firewall.evaluate(makePacket({ sourceAddress: "10.1.2.4" })),
    "DENY",
  );
});

test("no fully matching rule defaults to DENY", () => {
  const firewall = firewallWith([
    {
      sourceZone: "dmz",
      destinationZone: "core",
      rules: [
        makeRule({
          priority: 1,
          sourceCidr: "172.16.0.0/12",
          action: "ALLOW",
        }),
        makeRule({
          priority: 2,
          protocol: "UDP",
          action: "ALLOW",
        }),
      ],
    },
  ]);
  assert.equal(firewall.evaluate(makePacket()), "DENY");
});

test("missing reverse policy defaults to DENY and does not borrow forward ALLOW", () => {
  const firewall = firewallWith([
    {
      sourceZone: "dmz",
      destinationZone: "core",
      rules: [makeRule({ priority: 1, action: "ALLOW" })],
    },
  ]);
  assert.equal(firewall.evaluate(makePacket()), "ALLOW");
  assert.equal(
    firewall.evaluate(
      makePacket({
        sourceZone: "core",
        destinationZone: "dmz",
        sourceAddress: "192.168.4.5",
        destinationAddress: "10.1.2.3",
      }),
    ),
    "DENY",
  );
});

test("no policy at all defaults to DENY", () => {
  const firewall = firewallWith([]);
  assert.equal(firewall.evaluate(makePacket()), "DENY");
});

test("intra-zone traffic is denied", () => {
  const firewall = firewallWith([
    {
      sourceZone: "dmz",
      destinationZone: "dmz",
      rules: [makeRule({ priority: 1, action: "ALLOW" })],
    },
  ]);
  assert.equal(
    firewall.evaluate(makePacket({ destinationZone: "dmz" })),
    "DENY",
  );
});

test("loadPolicies replaces previously loaded policies", () => {
  const firewall = firewallWith([
    {
      sourceZone: "dmz",
      destinationZone: "core",
      rules: [makeRule({ priority: 1, action: "ALLOW" })],
    },
  ]);
  assert.equal(firewall.evaluate(makePacket()), "ALLOW");
  firewall.loadPolicies([]);
  assert.equal(firewall.evaluate(makePacket()), "DENY");
});

test("duplicate priorities within one policy are rejected", () => {
  const firewall = new Firewall();
  assert.throws(() =>
    firewall.loadPolicies([
      {
        sourceZone: "dmz",
        destinationZone: "core",
        rules: [makeRule({ priority: 1 }), makeRule({ priority: 1 })],
      },
    ]),
  );
});
