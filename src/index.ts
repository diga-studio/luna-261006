import { parseCidr } from "./cidr";
import { findConflictWitness } from "./conflict";
import type { Action, Packet, ReplaceResult, Rule } from "./types";

export type { Action, Packet, Protocol, ReplaceResult, Rule } from "./types";

function validateRule(rule: Rule, seenIds: Set<string>): void {
  if (seenIds.has(rule.id)) {
    throw new Error(`duplicate rule id: ${rule.id}`);
  }
  seenIds.add(rule.id);
  parseCidr(rule.sourceCidr);
  parseCidr(rule.destCidr);
  if (rule.protocol !== "TCP" && rule.protocol !== "UDP") {
    throw new Error(`unsupported protocol: ${rule.protocol}`);
  }
  if (
    !Number.isInteger(rule.portStart) ||
    !Number.isInteger(rule.portEnd) ||
    rule.portStart < 1 ||
    rule.portEnd > 65535 ||
    rule.portStart > rule.portEnd
  ) {
    throw new Error(`invalid port range: ${rule.portStart}-${rule.portEnd}`);
  }
  if (rule.action !== "allow" && rule.action !== "deny") {
    throw new Error(`invalid action: ${rule.action}`);
  }
  if (!Number.isFinite(rule.priority)) {
    throw new Error(`invalid priority: ${rule.priority}`);
  }
}

export class PolicyEngine {
  private rules: Rule[] = [];

  replacePolicy(rules: Rule[]): ReplaceResult {
    const seenIds = new Set<string>();
    for (const rule of rules) {
      validateRule(rule, seenIds);
    }
    const witness = findConflictWitness(rules);
    if (witness !== null) {
      return { ok: false, witness };
    }
    this.rules = rules.map((rule) => ({ ...rule }));
    return { ok: true };
  }

  evaluate(packet: Packet): Action {
    const src = parseCidr(`${packet.sourceAddress}/32`).start;
    const dst = parseCidr(`${packet.destAddress}/32`).start;
    let bestPriority: number | null = null;
    let decision: Action | null = null;
    for (const rule of this.rules) {
      if (rule.protocol !== packet.protocol) {
        continue;
      }
      if (packet.destPort < rule.portStart || packet.destPort > rule.portEnd) {
        continue;
      }
      const srcRange = parseCidr(rule.sourceCidr);
      if (src < srcRange.start || src > srcRange.end) {
        continue;
      }
      const dstRange = parseCidr(rule.destCidr);
      if (dst < dstRange.start || dst > dstRange.end) {
        continue;
      }
      if (bestPriority === null || rule.priority < bestPriority) {
        bestPriority = rule.priority;
        decision = rule.action;
      } else if (rule.priority === bestPriority && decision !== rule.action) {
        decision = "deny";
      }
    }
    return decision ?? "deny";
  }

  getRules(): Rule[] {
    return this.rules.map((rule) => ({ ...rule }));
  }
}
