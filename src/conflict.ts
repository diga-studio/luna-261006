import { intersectBoxes, subtractBoxes, type Box } from "./box";
import { ipv4ToString, parseCidr } from "./cidr";
import type { Packet, Protocol, Rule } from "./types";

const PROTOCOLS: Protocol[] = ["TCP", "UDP"];

function ruleToBox(rule: Rule): Box {
  return {
    src: parseCidr(rule.sourceCidr),
    dst: parseCidr(rule.destCidr),
    port: { start: rule.portStart, end: rule.portEnd },
  };
}

function findProtocolConflict(
  rules: Rule[],
  protocol: Protocol
): Packet | null {
  const byPriority = new Map<number, Rule[]>();
  for (const rule of rules) {
    if (rule.protocol !== protocol) {
      continue;
    }
    const group = byPriority.get(rule.priority);
    if (group === undefined) {
      byPriority.set(rule.priority, [rule]);
    } else {
      group.push(rule);
    }
  }
  const priorities = [...byPriority.keys()].sort((a, b) => a - b);
  const shadowing: Box[] = [];
  for (const priority of priorities) {
    const group = byPriority.get(priority)!;
    const allowBoxes = group
      .filter((rule) => rule.action === "allow")
      .map(ruleToBox);
    const denyBoxes = group
      .filter((rule) => rule.action === "deny")
      .map(ruleToBox);
    for (const allowBox of allowBoxes) {
      for (const denyBox of denyBoxes) {
        const overlap = intersectBoxes(allowBox, denyBox);
        if (overlap === null) {
          continue;
        }
        const exposed = subtractBoxes(overlap, shadowing);
        if (exposed.length > 0) {
          const witness = exposed[0];
          return {
            sourceAddress: ipv4ToString(witness.src.start),
            destAddress: ipv4ToString(witness.dst.start),
            protocol,
            destPort: witness.port.start,
          };
        }
      }
    }
    for (const rule of group) {
      shadowing.push(ruleToBox(rule));
    }
  }
  return null;
}

export function findConflictWitness(rules: Rule[]): Packet | null {
  for (const protocol of PROTOCOLS) {
    const witness = findProtocolConflict(rules, protocol);
    if (witness !== null) {
      return witness;
    }
  }
  return null;
}
