import { ruleMatches } from "./match.js";
function policyKey(sourceSegment, destinationSegment) {
    return sourceSegment + "\0" + destinationSegment;
}
export class Firewall {
    policies = new Map();
    loadPolicies(policies) {
        this.policies.clear();
        for (const policy of policies) {
            const key = policyKey(policy.sourceSegment, policy.destinationSegment);
            if (this.policies.has(key)) {
                throw new Error(`duplicate policy for segment pair ${policy.sourceSegment} -> ${policy.destinationSegment}`);
            }
            const seen = new Set();
            for (const rule of policy.rules) {
                if (seen.has(rule.priority)) {
                    throw new Error(`duplicate priority ${rule.priority} in policy ${key}`);
                }
                seen.add(rule.priority);
            }
            this.policies.set(key, policy);
        }
    }
    decide(packet) {
        if (packet.sourceSegment === packet.destinationSegment) {
            return "DENY";
        }
        const policy = this.policies.get(policyKey(packet.sourceSegment, packet.destinationSegment));
        if (policy === undefined) {
            return "DENY";
        }
        let best;
        for (const rule of policy.rules) {
            if (!ruleMatches(rule, packet)) {
                continue;
            }
            if (best === undefined || rule.priority < best.priority) {
                best = { priority: rule.priority, decision: rule.action };
            }
        }
        return best === undefined ? "DENY" : best.decision;
    }
}
