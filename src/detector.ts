import type { Detector, HitSummary, RuleSpec, TelemetryEvent } from "./types.ts";
import { baseSummary } from "./monoid.ts";
import { SlidingWindowAggregator } from "./swag.ts";

interface NormalizedStage {
  readonly eventType: string;
  readonly equals: ReadonlyArray<readonly [string, string]>;
}

interface NormalizedRule {
  readonly ruleId: string;
  readonly windowMs: number;
  readonly k: number;
  readonly stages: readonly NormalizedStage[];
}

interface AgentState {
  readonly swags: SlidingWindowAggregator[];
}

function normalizeRules(rules: readonly RuleSpec[]): NormalizedRule[] {
  if (!Array.isArray(rules)) {
    throw new TypeError("rules must be an array");
  }
  return rules.map((rule, index) => {
    const where = `rules[${index}]`;
    if (rule === null || typeof rule !== "object") {
      throw new TypeError(`${where} must be an object`);
    }
    if (typeof rule.ruleId !== "string" || rule.ruleId.length === 0) {
      throw new TypeError(`${where}.ruleId must be a non-empty string`);
    }
    if (
      typeof rule.windowMs !== "number" ||
      !Number.isFinite(rule.windowMs) ||
      rule.windowMs < 0
    ) {
      throw new TypeError(`${where}.windowMs must be a finite number >= 0`);
    }
    if (!Array.isArray(rule.stages) || rule.stages.length < 2 || rule.stages.length > 8) {
      throw new TypeError(`${where}.stages must contain 2 to 8 stages`);
    }
    const stages = rule.stages.map((stage, stageIndex) => {
      const stageWhere = `${where}.stages[${stageIndex}]`;
      if (stage === null || typeof stage !== "object") {
        throw new TypeError(`${stageWhere} must be an object`);
      }
      if (typeof stage.eventType !== "string" || stage.eventType.length === 0) {
        throw new TypeError(`${stageWhere}.eventType must be a non-empty string`);
      }
      const equals: Array<readonly [string, string]> = [];
      if (stage.payloadEquals !== undefined) {
        if (stage.payloadEquals === null || typeof stage.payloadEquals !== "object") {
          throw new TypeError(`${stageWhere}.payloadEquals must be an object`);
        }
        for (const [key, value] of Object.entries(stage.payloadEquals)) {
          if (typeof value !== "string") {
            throw new TypeError(`${stageWhere}.payloadEquals["${key}"] must be a string`);
          }
          equals.push([key, value] as const);
        }
      }
      return Object.freeze({ eventType: stage.eventType, equals: Object.freeze(equals) });
    });
    return Object.freeze({
      ruleId: rule.ruleId,
      windowMs: rule.windowMs,
      k: stages.length,
      stages: Object.freeze(stages),
    });
  });
}

function matchStage(stage: NormalizedStage, event: TelemetryEvent): boolean {
  if (event.eventType !== stage.eventType) {
    return false;
  }
  for (const [key, value] of stage.equals) {
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
  return true;
}

// Returns a boolean per stage, or null when the event matches no stage at
// all (such events can never belong to a chain for this rule).
function matchEvent(rule: NormalizedRule, event: TelemetryEvent): boolean[] | null {
  const matched = new Array<boolean>(rule.k);
  let any = false;
  for (let j = 0; j < rule.k; j++) {
    const hit = matchStage(rule.stages[j], event);
    matched[j] = hit;
    any = any || hit;
  }
  return any ? matched : null;
}

export function createDetector(rules: readonly RuleSpec[]): Detector {
  const normalized = normalizeRules(rules);
  let currentTime: number | null = null;
  const agents = new Map<string, AgentState>();

  function evictBefore(state: AgentState, cutoffPerRule: (rule: NormalizedRule) => number): void {
    for (let i = 0; i < normalized.length; i++) {
      const swag = state.swags[i];
      const cutoff = cutoffPerRule(normalized[i]);
      while (swag.size > 0) {
        const front = swag.frontTs();
        if (front === undefined || front >= cutoff) break;
        swag.popFront();
      }
    }
  }

  function dropIfIdle(agentId: string, state: AgentState): void {
    for (const swag of state.swags) {
      if (swag.size > 0) return;
    }
    agents.delete(agentId);
  }

  return {
    ingest(events: readonly TelemetryEvent[]): HitSummary[] {
      if (!Array.isArray(events)) {
        throw new TypeError("events must be an array");
      }
      const hits: HitSummary[] = [];
      for (const event of events) {
        if (typeof event.ts !== "number" || !Number.isFinite(event.ts)) {
          throw new TypeError("event.ts must be a finite number");
        }
        if (currentTime !== null && event.ts < currentTime) {
          throw new Error(
            `event ts ${event.ts} is before current time ${currentTime}`,
          );
        }
        currentTime = event.ts;

        let state = agents.get(event.agentId);
        if (state === undefined) {
          state = {
            swags: normalized.map((rule) => new SlidingWindowAggregator(rule.k)),
          };
          agents.set(event.agentId, state);
        }

        evictBefore(state, (rule) => event.ts - rule.windowMs);

        for (let i = 0; i < normalized.length; i++) {
          const rule = normalized[i];
          const matched = matchEvent(rule, event);
          if (matched === null) continue;
          const swag = state.swags[i];
          if (matched[rule.k - 1]) {
            // Chains ending exactly at this event: pick stages 1..k-1 from
            // the live window (all ts >= event.ts - W, all preceding this
            // event in input order) and use this event as stage k.
            const count = swag.query()[0][rule.k - 2];
            if (count > 0n) {
              hits.push({
                ruleId: rule.ruleId,
                agentId: event.agentId,
                eventId: event.eventId,
                count: count.toString(),
              });
            }
          }
          swag.push(event.ts, baseSummary(rule.k, matched));
        }

        dropIfIdle(event.agentId, state);
      }
      return hits;
    },

    advanceTo(t: number): void {
      if (typeof t !== "number" || !Number.isFinite(t)) {
        throw new TypeError("t must be a finite number");
      }
      if (currentTime !== null && t < currentTime) {
        throw new Error(`advanceTo(${t}) moves time backwards from ${currentTime}`);
      }
      currentTime = t;
      for (const [agentId, state] of agents) {
        evictBefore(state, (rule) => t - rule.windowMs);
        dropIfIdle(agentId, state);
      }
    },
  };
}
