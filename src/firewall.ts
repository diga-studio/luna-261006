import { cidrContains, parseCidr, parseIpv4 } from "./cidr";
import { Decision, Packet, Policy, Rule } from "./types";

interface CompiledRule {
  readonly priority: number;
  readonly sourceNetwork: number;
  readonly sourcePrefixLength: number;
  readonly destinationNetwork: number;
  readonly destinationPrefixLength: number;
  readonly rule: Rule;
}

interface CompiledPolicy {
  readonly rules: readonly CompiledRule[];
}

export class Firewall {
  private readonly policies = new Map<string, CompiledPolicy>();

  loadPolicies(policies: readonly Policy[]): void {
    this.policies.clear();
    for (const policy of policies) {
      const key = policyKey(policy.sourceZone, policy.destinationZone);
      if (this.policies.has(key)) {
        throw new Error(
          `duplicate policy for ${policy.sourceZone} -> ${policy.destinationZone}`,
        );
      }
      this.policies.set(key, compilePolicy(policy));
    }
  }

  evaluate(packet: Packet): Decision {
    if (packet.sourceZone === packet.destinationZone) {
      return "DENY";
    }
    const policy = this.policies.get(
      policyKey(packet.sourceZone, packet.destinationZone),
    );
    if (policy === undefined) {
      return "DENY";
    }
    const sourceAddress = parseIpv4(packet.sourceAddress);
    const destinationAddress = parseIpv4(packet.destinationAddress);
    let best: CompiledRule | undefined;
    for (const compiled of policy.rules) {
      if (!matches(compiled, packet, sourceAddress, destinationAddress)) {
        continue;
      }
      if (best === undefined || compiled.priority < best.priority) {
        best = compiled;
      }
    }
    return best === undefined ? "DENY" : best.rule.action;
  }
}

function policyKey(sourceZone: string, destinationZone: string): string {
  return `${sourceZone} -> ${destinationZone}`;
}

function compilePolicy(policy: Policy): CompiledPolicy {
  const seen = new Set<number>();
  const rules: CompiledRule[] = [];
  for (const rule of policy.rules) {
    if (seen.has(rule.priority)) {
      throw new Error(
        `duplicate priority ${rule.priority} in policy ${policy.sourceZone} -> ${policy.destinationZone}`,
      );
    }
    seen.add(rule.priority);
    const source = parseCidr(rule.sourceCidr);
    const destination = parseCidr(rule.destinationCidr);
    rules.push({
      priority: rule.priority,
      sourceNetwork: source.network,
      sourcePrefixLength: source.prefixLength,
      destinationNetwork: destination.network,
      destinationPrefixLength: destination.prefixLength,
      rule,
    });
  }
  return { rules };
}

function matches(
  compiled: CompiledRule,
  packet: Packet,
  sourceAddress: number,
  destinationAddress: number,
): boolean {
  const rule = compiled.rule;
  if (rule.protocol !== packet.protocol) {
    return false;
  }
  if (
    !cidrContains(
      { network: compiled.sourceNetwork, prefixLength: compiled.sourcePrefixLength },
      sourceAddress,
    )
  ) {
    return false;
  }
  if (
    !cidrContains(
      {
        network: compiled.destinationNetwork,
        prefixLength: compiled.destinationPrefixLength,
      },
      destinationAddress,
    )
  ) {
    return false;
  }
  if (rule.protocol !== "ICMP") {
    if (
      rule.sourcePorts === undefined ||
      rule.destinationPorts === undefined ||
      packet.sourcePort === undefined ||
      packet.destinationPort === undefined
    ) {
      return false;
    }
    if (
      packet.sourcePort < rule.sourcePorts.start ||
      packet.sourcePort > rule.sourcePorts.end ||
      packet.destinationPort < rule.destinationPorts.start ||
      packet.destinationPort > rule.destinationPorts.end
    ) {
      return false;
    }
  }
  if (rule.timeWindows.length > 0) {
    const inWindow = rule.timeWindows.some(
      (window) =>
        packet.minuteOfWeek >= window.start && packet.minuteOfWeek < window.end,
    );
    if (!inWindow) {
      return false;
    }
  }
  return true;
}
