import test from "node:test";
import assert from "node:assert/strict";
import { Firewall } from "../src/index.js";
import type { Packet, Rule, SegmentPairPolicy } from "../src/index.js";

function ip(text: string): number {
  const parts = text.split(".").map(Number);
  assert.equal(parts.length, 4);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function cidr(text: string): { address: number; prefixLength: number } {
  const [addr, prefix] = text.split("/");
  return { address: ip(addr), prefixLength: Number(prefix) };
}

function tcpPacket(overrides: Partial<Packet> = {}): Packet {
  return {
    sourceSegment: "dmz",
    destinationSegment: "core",
    sourceAddress: ip("10.1.2.3"),
    destinationAddress: ip("192.168.1.10"),
    protocol: "TCP",
    sourcePort: 5000,
    destinationPort: 443,
    minuteOfWeek: 600,
    ...overrides,
  };
}

function firewallWith(rules: Rule[]): Firewall {
  const policy: SegmentPairPolicy = {
    sourceSegment: "dmz",
    destinationSegment: "core",
    rules,
  };
  const fw = new Firewall();
  fw.loadPolicies([policy]);
  return fw;
}

test("picks the smallest priority among fully matching rules with different actions", () => {
  const fw = firewallWith([
    { priority: 30, sourceCidr: cidr("10.0.0.0/8"), destinationCidr: cidr("192.168.0.0/16"), protocol: "TCP", sourcePorts: { start: 1, end: 65535 }, destinationPorts: { start: 443, end: 443 }, timeRanges: [], action: "ALLOW" },
    { priority: 10, sourceCidr: cidr("10.0.0.0/8"), destinationCidr: cidr("192.168.0.0/16"), protocol: "TCP", sourcePorts: { start: 1, end: 65535 }, destinationPorts: { start: 443, end: 443 }, timeRanges: [], action: "RATE_LIMIT" },
    { priority: 20, sourceCidr: cidr("10.0.0.0/8"), destinationCidr: cidr("192.168.0.0/16"), protocol: "TCP", sourcePorts: { start: 1, end: 65535 }, destinationPorts: { start: 443, end: 443 }, timeRanges: [], action: "DENY" },
  ]);
  assert.equal(fw.decide(tcpPacket()), "RATE_LIMIT");
});

test("falls through when the higher-priority rule mismatches only on ports", () => {
  const fw = firewallWith([
    { priority: 5, sourceCidr: cidr("10.0.0.0/8"), destinationCidr: cidr("192.168.0.0/16"), protocol: "TCP", sourcePorts: { start: 1, end: 65535 }, destinationPorts: { start: 22, end: 22 }, timeRanges: [], action: "DENY" },
    { priority: 9, sourceCidr: cidr("10.0.0.0/8"), destinationCidr: cidr("192.168.0.0/16"), protocol: "TCP", sourcePorts: { start: 1, end: 65535 }, destinationPorts: { start: 443, end: 443 }, timeRanges: [], action: "ALLOW" },
  ]);
  assert.equal(fw.decide(tcpPacket()), "ALLOW");
  assert.equal(fw.decide(tcpPacket({ destinationPort: 22 })), "DENY");
});

test("falls through when the higher-priority rule mismatches only on time window", () => {
  const fw = firewallWith([
    { priority: 5, sourceCidr: cidr("10.0.0.0/8"), destinationCidr: cidr("192.168.0.0/16"), protocol: "TCP", sourcePorts: { start: 1, end: 65535 }, destinationPorts: { start: 1, end: 65535 }, timeRanges: [{ startMinute: 0, endMinute: 60 }], action: "DENY" },
    { priority: 9, sourceCidr: cidr("10.0.0.0/8"), destinationCidr: cidr("192.168.0.0/16"), protocol: "TCP", sourcePorts: { start: 1, end: 65535 }, destinationPorts: { start: 1, end: 65535 }, timeRanges: [], action: "ALLOW" },
  ]);
  assert.equal(fw.decide(tcpPacket({ minuteOfWeek: 600 })), "ALLOW");
  assert.equal(fw.decide(tcpPacket({ minuteOfWeek: 30 })), "DENY");
});

test("more specific CIDR does not win over smaller priority", () => {
  const fw = firewallWith([
    { priority: 20, sourceCidr: cidr("10.1.2.3/32"), destinationCidr: cidr("192.168.1.10/32"), protocol: "TCP", sourcePorts: { start: 1, end: 65535 }, destinationPorts: { start: 1, end: 65535 }, timeRanges: [], action: "DENY" },
    { priority: 10, sourceCidr: cidr("0.0.0.0/0"), destinationCidr: cidr("0.0.0.0/0"), protocol: "TCP", sourcePorts: { start: 1, end: 65535 }, destinationPorts: { start: 1, end: 65535 }, timeRanges: [], action: "ALLOW" },
  ]);
  assert.equal(fw.decide(tcpPacket()), "ALLOW");
});

test("default deny when every rule mismatches", () => {
  const fw = firewallWith([
    { priority: 1, sourceCidr: cidr("172.16.0.0/12"), destinationCidr: cidr("192.168.0.0/16"), protocol: "TCP", sourcePorts: { start: 1, end: 65535 }, destinationPorts: { start: 1, end: 65535 }, timeRanges: [], action: "ALLOW" },
    { priority: 2, sourceCidr: cidr("10.0.0.0/8"), destinationCidr: cidr("192.168.0.0/16"), protocol: "UDP", sourcePorts: { start: 1, end: 65535 }, destinationPorts: { start: 1, end: 65535 }, timeRanges: [], action: "ALLOW" },
  ]);
  assert.equal(fw.decide(tcpPacket()), "DENY");
});

test("default deny when the reverse-direction policy is missing", () => {
  const fw = firewallWith([
    { priority: 1, sourceCidr: cidr("0.0.0.0/0"), destinationCidr: cidr("0.0.0.0/0"), protocol: "TCP", sourcePorts: { start: 1, end: 65535 }, destinationPorts: { start: 1, end: 65535 }, timeRanges: [], action: "ALLOW" },
  ]);
  assert.equal(fw.decide(tcpPacket()), "ALLOW");
  const reverse = tcpPacket({
    sourceSegment: "core",
    destinationSegment: "dmz",
    sourceAddress: ip("192.168.1.10"),
    destinationAddress: ip("10.1.2.3"),
  });
  assert.equal(fw.decide(reverse), "DENY");
});

test("default deny when no policy exists for the direction at all", () => {
  const fw = new Firewall();
  fw.loadPolicies([]);
  assert.equal(fw.decide(tcpPacket()), "DENY");
});

test("ICMP rules match without comparing ports", () => {
  const fw = firewallWith([
    { priority: 1, sourceCidr: cidr("10.0.0.0/8"), destinationCidr: cidr("192.168.0.0/16"), protocol: "ICMP", timeRanges: [], action: "ALLOW" },
  ]);
  const packet = tcpPacket({ protocol: "ICMP", sourcePort: undefined, destinationPort: undefined });
  assert.equal(fw.decide(packet), "ALLOW");
});

test("port range endpoints are inclusive", () => {
  const fw = firewallWith([
    { priority: 1, sourceCidr: cidr("0.0.0.0/0"), destinationCidr: cidr("0.0.0.0/0"), protocol: "TCP", sourcePorts: { start: 5000, end: 5000 }, destinationPorts: { start: 443, end: 443 }, timeRanges: [], action: "ALLOW" },
  ]);
  assert.equal(fw.decide(tcpPacket({ sourcePort: 5000, destinationPort: 443 })), "ALLOW");
  assert.equal(fw.decide(tcpPacket({ sourcePort: 4999 })), "DENY");
});

test("time ranges are half-open and empty list means all week", () => {
  const fw = firewallWith([
    { priority: 1, sourceCidr: cidr("0.0.0.0/0"), destinationCidr: cidr("0.0.0.0/0"), protocol: "TCP", sourcePorts: { start: 1, end: 65535 }, destinationPorts: { start: 1, end: 65535 }, timeRanges: [{ startMinute: 120, endMinute: 240 }, { startMinute: 600, endMinute: 660 }], action: "ALLOW" },
  ]);
  assert.equal(fw.decide(tcpPacket({ minuteOfWeek: 120 })), "ALLOW");
  assert.equal(fw.decide(tcpPacket({ minuteOfWeek: 240 })), "DENY");
  assert.equal(fw.decide(tcpPacket({ minuteOfWeek: 659 })), "ALLOW");
  assert.equal(fw.decide(tcpPacket({ minuteOfWeek: 660 })), "DENY");
});

test("duplicate priority inside one policy is rejected", () => {
  const policy: SegmentPairPolicy = {
    sourceSegment: "dmz",
    destinationSegment: "core",
    rules: [
      { priority: 1, sourceCidr: cidr("0.0.0.0/0"), destinationCidr: cidr("0.0.0.0/0"), protocol: "TCP", sourcePorts: { start: 1, end: 65535 }, destinationPorts: { start: 1, end: 65535 }, timeRanges: [], action: "ALLOW" },
      { priority: 1, sourceCidr: cidr("0.0.0.0/0"), destinationCidr: cidr("0.0.0.0/0"), protocol: "TCP", sourcePorts: { start: 1, end: 65535 }, destinationPorts: { start: 1, end: 65535 }, timeRanges: [], action: "DENY" },
    ],
  };
  const fw = new Firewall();
  assert.throws(() => fw.loadPolicies([policy]), /duplicate priority/);
});

test("same-segment traffic is denied", () => {
  const fw = firewallWith([
    { priority: 1, sourceCidr: cidr("0.0.0.0/0"), destinationCidr: cidr("0.0.0.0/0"), protocol: "TCP", sourcePorts: { start: 1, end: 65535 }, destinationPorts: { start: 1, end: 65535 }, timeRanges: [], action: "ALLOW" },
  ]);
  assert.equal(fw.decide(tcpPacket({ sourceSegment: "core" })), "DENY");
});

test("loadPolicies replaces previously loaded policies", () => {
  const fw = firewallWith([
    { priority: 1, sourceCidr: cidr("0.0.0.0/0"), destinationCidr: cidr("0.0.0.0/0"), protocol: "TCP", sourcePorts: { start: 1, end: 65535 }, destinationPorts: { start: 1, end: 65535 }, timeRanges: [], action: "ALLOW" },
  ]);
  assert.equal(fw.decide(tcpPacket()), "ALLOW");
  fw.loadPolicies([]);
  assert.equal(fw.decide(tcpPacket()), "DENY");
});
