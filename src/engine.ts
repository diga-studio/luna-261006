import { parseCidr, parseIpv4, formatIpv4 } from "./cidr.js";
import { intersectBoxes, subtractBoxes, type Box } from "./box.js";
import type {
  Action,
  Decision,
  Packet,
  PublishResult,
  Rule,
} from "./types.js";

interface CompiledRule {
  source: Rule;
  action: Action;
  priority: number;
  box: Box;
}

function validateRule(rule: Rule, seen: Set<string>): void {
  if (typeof rule.id !== "string" || rule.id.length === 0) {
    throw new Error("rule id must be a non-empty string");
  }
  if (seen.has(rule.id)) {
    throw new Error(`duplicate rule id: ${rule.id}`);
  }
  seen.add(rule.id);
  if (rule.protocol !== "TCP" && rule.protocol !== "UDP") {
    throw new Error(`rule ${rule.id}: unsupported protocol`);
  }
  if (rule.action !== "allow" && rule.action !== "deny") {
    throw new Error(`rule ${rule.id}: unsupported action`);
  }
  for (const [name, port] of [
    ["portStart", rule.portStart],
    ["portEnd", rule.portEnd],
  ] as const) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`rule ${rule.id}: ${name} out of range`);
    }
  }
  if (rule.portStart > rule.portEnd) {
    throw new Error(`rule ${rule.id}: portStart > portEnd`);
  }
  if (!Number.isInteger(rule.priority)) {
    throw new Error(`rule ${rule.id}: priority must be an integer`);
  }
}

function compile(rule: Rule): CompiledRule {
  return {
    source: rule,
    action: rule.action,
    priority: rule.priority,
    box: {
      src: parseCidr(rule.sourceCidr),
      dst: parseCidr(rule.destinationCidr),
      protocols: [rule.protocol],
      portLo: rule.portStart,
      portHi: rule.portEnd,
    },
  };
}

function firstPacketIn(box: Box): Packet {
  return {
    sourceAddress: formatIpv4(box.src.lo),
    destinationAddress: formatIpv4(box.dst.lo),
    protocol: box.protocols[0]!,
    destinationPort: box.portLo,
  };
}

/**
 * 在候选规则集中寻找一个冲突数据包：
 * 存在某个优先级 p，数据包在 p 上同时命中 allow 与 deny，
 * 且不被任何更高优先级（数值更小）的规则覆盖。
 * 找到则返回见证，否则返回 null。
 */
function findConflict(rules: readonly CompiledRule[]): Packet | null {
  const priorities = [...new Set(rules.map((r) => r.priority))].sort(
    (a, b) => a - b,
  );
  const higherBoxes: Box[] = [];
  for (const priority of priorities) {
    const atLevel = rules.filter((r) => r.priority === priority);
    const allows = atLevel.filter((r) => r.action === "allow");
    const denies = atLevel.filter((r) => r.action === "deny");
    for (const allow of allows) {
      for (const deny of denies) {
        const overlap = intersectBoxes(allow.box, deny.box);
        if (!overlap) {
          continue;
        }
        const exposed = subtractBoxes(overlap, higherBoxes);
        if (exposed.length > 0) {
          return firstPacketIn(exposed[0]!);
        }
      }
    }
    for (const rule of atLevel) {
      higherBoxes.push(rule.box);
    }
  }
  return null;
}

/**
 * IronPerimeter 微隔离策略引擎。
 * 候选策略与已生效策略均保存在进程内存中。
 */
export class PolicyEngine {
  private effective: CompiledRule[] = [];

  /**
   * 用候选策略整体替换当前生效策略。
   * 候选策略存在歧义（某个数据包在最小命中优先级上同时命中 allow 与 deny）时拒绝，
   * 返回一个冲突数据包见证，原策略保持不变。
   */
  replacePolicy(rules: readonly Rule[]): PublishResult {
    const seen = new Set<string>();
    const compiled = rules.map((rule) => {
      validateRule(rule, seen);
      return compile(rule);
    });
    const witness = findConflict(compiled);
    if (witness) {
      return { ok: false, witness };
    }
    this.effective = compiled;
    return { ok: true };
  }

  /** 当前生效策略的规则快照。 */
  getEffectiveRules(): Rule[] {
    return this.effective.map((rule) => ({ ...rule.source }));
  }

  /** 判定一个数据包在当前生效策略下的结果。 */
  evaluate(packet: Packet): Decision {
    const src = parseIpv4(packet.sourceAddress);
    const dst = parseIpv4(packet.destinationAddress);
    const matched = this.effective.filter(
      (rule) =>
        src >= rule.box.src.lo &&
        src <= rule.box.src.hi &&
        dst >= rule.box.dst.lo &&
        dst <= rule.box.dst.hi &&
        rule.box.protocols.includes(packet.protocol) &&
        packet.destinationPort >= rule.box.portLo &&
        packet.destinationPort <= rule.box.portHi,
    );
    if (matched.length === 0) {
      return { kind: "default-deny" };
    }
    const priority = Math.min(...matched.map((rule) => rule.priority));
    const atLevel = matched.filter((rule) => rule.priority === priority);
    const actions = new Set(atLevel.map((rule) => rule.action));
    const matchedRuleIds = atLevel.map((rule) => rule.source.id);
    if (actions.size > 1) {
      return { kind: "conflict", priority, matchedRuleIds };
    }
    return {
      kind: "action",
      action: atLevel[0]!.action,
      priority,
      matchedRuleIds,
    };
  }
}
