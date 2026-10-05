import type { HitSummary, RuleSpec, TelemetryEvent } from "../src/types.ts";

function stageMatches(
  stage: { eventType: string; payloadEquals?: Readonly<Record<string, string>> },
  event: TelemetryEvent,
): boolean {
  if (event.eventType !== stage.eventType) return false;
  if (stage.payloadEquals !== undefined) {
    for (const [key, value] of Object.entries(stage.payloadEquals)) {
      const payload = event.payload;
      if (
        payload === undefined ||
        payload === null ||
        !Object.prototype.hasOwnProperty.call(payload, key) ||
        payload[key] !== value
      ) {
        return false;
      }
    }
  }
  return true;
}

// Counts chains of stages 0..stageIndex drawn from prior[0..before), where
// the chain's first event must satisfy lastTs - firstTs <= windowMs.
function countChains(
  rule: RuleSpec,
  prior: readonly TelemetryEvent[],
  stageIndex: number,
  before: number,
  lastTs: number,
): bigint {
  if (stageIndex === 0) {
    let count = 0n;
    for (let i = 0; i < before; i++) {
      if (
        lastTs - prior[i].ts <= rule.windowMs &&
        stageMatches(rule.stages[0], prior[i])
      ) {
        count++;
      }
    }
    return count;
  }
  let total = 0n;
  for (let i = 0; i < before; i++) {
    if (stageMatches(rule.stages[stageIndex], prior[i])) {
      total += countChains(rule, prior, stageIndex - 1, i, lastTs);
    }
  }
  return total;
}

// Independent exhaustive reference: for every rule and every event, counts
// all legal chains whose last stage is that event, by direct enumeration.
export function bruteForceHits(
  rules: readonly RuleSpec[],
  events: readonly TelemetryEvent[],
): HitSummary[] {
  const hits: HitSummary[] = [];
  for (const rule of rules) {
    const k = rule.stages.length;
    for (let j = 0; j < events.length; j++) {
      const last = events[j];
      if (!stageMatches(rule.stages[k - 1], last)) continue;
      const prior: TelemetryEvent[] = [];
      for (let i = 0; i < j; i++) {
        if (events[i].agentId === last.agentId) prior.push(events[i]);
      }
      const count = countChains(rule, prior, k - 2, prior.length, last.ts);
      if (count > 0n) {
        hits.push({
          ruleId: rule.ruleId,
          agentId: last.agentId,
          eventId: last.eventId,
          count: count.toString(),
        });
      }
    }
  }
  return hits;
}

export function sortHits(hits: readonly HitSummary[]): HitSummary[] {
  return [...hits].sort((a, b) => {
    const ka = `${a.ruleId} ${a.agentId} ${a.eventId}`;
    const kb = `${b.ruleId} ${b.agentId} ${b.eventId}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}
