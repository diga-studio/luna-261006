import type { HitSummary, Rule, TelemetryEvent } from "../src/types";

/**
 * Independent brute-force reference detector.
 * Keeps every event and, for each ending event, counts chains with an
 * O(n^2 * k) dynamic program over the full history. Only suitable for
 * small inputs; used to cross-check the streaming implementation.
 */
export class ReferenceDetector {
  private readonly rules: readonly Rule[];
  private readonly events: TelemetryEvent[] = [];

  constructor(rules: readonly Rule[]) {
    this.rules = rules;
  }

  ingest(batch: readonly TelemetryEvent[]): HitSummary[] {
    const hits: HitSummary[] = [];
    for (const event of batch) {
      this.events.push(event);
      const endIdx = this.events.length - 1;
      for (const rule of this.rules) {
        const count = this.countChainsEndingAt(endIdx, rule);
        if (count > 0n) {
          hits.push({
            ruleId: rule.ruleId,
            agentId: event.agentId,
            eventId: event.eventId,
            count: count.toString(10),
          });
        }
      }
    }
    return hits;
  }

  advanceTo(_t: number): void {
    // The reference keeps full history; expiry never changes final counts
    // because the window constraint is re-checked per chain.
  }

  private countChainsEndingAt(endIdx: number, rule: Rule): bigint {
    const end = this.events[endIdx]!;
    const k = rule.stages.length;
    const cutoff = end.ts - rule.windowMs;
    // dp[j][i] for j = 1..k computed iteratively; only same-agent events
    // with index <= endIdx and ts >= cutoff participate.
    const indices: number[] = [];
    for (let i = 0; i <= endIdx; i++) {
      const e = this.events[i]!;
      if (e.agentId === end.agentId && e.ts >= cutoff && e.ts <= end.ts) {
        indices.push(i);
      }
    }
    // prev[i] = number of chains of length j ending exactly at events[i].
    let prev = new Map<number, bigint>();
    for (const i of indices) {
      if (this.matches(this.events[i]!, rule.stages[0]!)) prev.set(i, 1n);
    }
    for (let j = 1; j < k; j++) {
      const next = new Map<number, bigint>();
      for (const i of indices) {
        if (!this.matches(this.events[i]!, rule.stages[j]!)) continue;
        let sum = 0n;
        for (const [pi, pv] of prev) {
          if (pi < i) sum += pv;
        }
        if (sum > 0n) next.set(i, sum);
      }
      prev = next;
    }
    return prev.get(endIdx) ?? 0n;
  }

  private matches(
    event: TelemetryEvent,
    stage: { eventType: string; conditions: Record<string, string> },
  ): boolean {
    if (event.eventType !== stage.eventType) return false;
    for (const key of Object.keys(stage.conditions)) {
      if (event.payload[key] !== stage.conditions[key]) return false;
    }
    return true;
  }
}

/** Normalize summaries into a comparable, order-independent map. */
export function summarize(hits: readonly HitSummary[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const h of hits) {
    const key = `${h.ruleId}${h.agentId}${h.eventId}`;
    if (map.has(key)) throw new Error(`duplicate summary key ${key}`);
    map.set(key, h.count);
  }
  return map;
}
