import type {
  Detector,
  HitSummary,
  Rule,
  Stage,
  TelemetryEvent,
} from "./types";

/**
 * Counting chains inside a sliding window reduces to a monoid aggregation
 * problem. For a segment of events define an upper-triangular matrix M over
 * stage indices 0..k, where M[a][b] (a < b) is the number of subsequences of
 * the segment matching stages a+1..b (in order), and the diagonal is an
 * implicit 1. Composition of adjacent segments is matrix multiplication:
 *   C[a][b] = A[a][b] + B[a][b] + sum_{a<m<b} A[a][m] * B[m][b]
 * which is associative, so a two-stack sliding-window aggregation (SWAG)
 * gives O(1) amortized composition per event. The zero matrix acts as the
 * identity element. A single event matching stage set `mask` is the matrix
 * with M[a][a+1] = 1 exactly when bit a of mask is set.
 */

interface StackEntry {
  ts: number;
  mask: number;
  /** Aggregate matrix of the stack segment ending (back) or starting (front) here. */
  agg: bigint[];
}

interface AgentRuleState {
  /** Oldest elements on top; agg[x] = leaf(x) composed with everything below x. */
  front: StackEntry[];
  /** Newest elements on top; agg[x] = everything below x composed with leaf(x). */
  back: StackEntry[];
}

interface RuleState {
  ruleId: string;
  windowMs: number;
  stageCount: number;
  stages: Stage[];
  size: number; // stageCount + 1
  agents: Map<string, AgentRuleState>;
}

function matchesStage(event: TelemetryEvent, stage: Stage): boolean {
  if (event.eventType !== stage.eventType) return false;
  for (const key of Object.keys(stage.conditions)) {
    if (event.payload[key] !== stage.conditions[key]) return false;
  }
  return true;
}

export function createDetector(rules: readonly Rule[]): Detector {
  const ruleStates: RuleState[] = rules.map((rule) => {
    if (!Number.isSafeInteger(rule.windowMs) || rule.windowMs < 0) {
      throw new Error(`rule ${rule.ruleId}: windowMs must be a non-negative safe integer`);
    }
    const stageCount = rule.stages.length;
    if (stageCount < 2 || stageCount > 8) {
      throw new Error(`rule ${rule.ruleId}: stages length must be between 2 and 8`);
    }
    return {
      ruleId: rule.ruleId,
      windowMs: rule.windowMs,
      stageCount,
      stages: rule.stages.map((s) => ({
        eventType: s.eventType,
        conditions: { ...s.conditions },
      })),
      size: stageCount + 1,
      agents: new Map<string, AgentRuleState>(),
    };
  });

  let currentTime: number | null = null;

  function setTime(t: number): void {
    if (!Number.isSafeInteger(t)) {
      throw new Error(`time must be an integer millisecond value, got ${t}`);
    }
    if (currentTime !== null && t < currentTime) {
      throw new Error(`time cannot move backwards: ${t} < ${currentTime}`);
    }
    currentTime = t;
  }

  function idx(rule: RuleState, a: number, b: number): number {
    return a * rule.size + b;
  }

  function leaf(rule: RuleState, mask: number): bigint[] {
    const m = new Array<bigint>(rule.size * rule.size).fill(0n);
    for (let a = 0; a < rule.stageCount; a++) {
      if ((mask >> a) & 1) m[idx(rule, a, a + 1)] = 1n;
    }
    return m;
  }

  function compose(rule: RuleState, left: bigint[], right: bigint[]): bigint[] {
    const k = rule.stageCount;
    const size = rule.size;
    const out = new Array<bigint>(size * size).fill(0n);
    for (let a = 0; a < k; a++) {
      const rowA = a * size;
      for (let b = a + 1; b <= k; b++) {
        let sum = left[rowA + b]! + right[rowA + b]!;
        for (let m = a + 1; m < b; m++) {
          const lv = left[rowA + m]!;
          if (lv === 0n) continue;
          const rv = right[m * size + b]!;
          if (rv === 0n) continue;
          sum += lv * rv;
        }
        out[rowA + b] = sum;
      }
    }
    return out;
  }

  function transfer(rule: RuleState, state: AgentRuleState): void {
    // Move everything from back to front, preserving order (oldest on top).
    while (state.back.length > 0) {
      const entry = state.back.pop()!;
      const lf = leaf(rule, entry.mask);
      const agg =
        state.front.length === 0
          ? lf
          : compose(rule, lf, state.front[state.front.length - 1]!.agg);
      state.front.push({ ts: entry.ts, mask: entry.mask, agg });
    }
  }

  function expire(rule: RuleState, state: AgentRuleState, cutoffTs: number): void {
    // Entries with ts < cutoffTs fall outside the window (boundary included).
    for (;;) {
      if (state.front.length === 0) {
        if (state.back.length === 0) return;
        transfer(rule, state);
      }
      if (state.front[state.front.length - 1]!.ts < cutoffTs) {
        state.front.pop();
      } else {
        return;
      }
    }
  }

  function windowAggregate(rule: RuleState, state: AgentRuleState): bigint[] | null {
    const frontTop = state.front[state.front.length - 1];
    const backTop = state.back[state.back.length - 1];
    if (frontTop === undefined) return backTop === undefined ? null : backTop.agg;
    if (backTop === undefined) return frontTop.agg;
    return compose(rule, frontTop.agg, backTop.agg);
  }

  return {
    ingest(events: readonly TelemetryEvent[]): HitSummary[] {
      const hits: HitSummary[] = [];
      for (const event of events) {
        setTime(event.ts);
        for (const rule of ruleStates) {
          const k = rule.stageCount;
          let state = rule.agents.get(event.agentId);
          if (state !== undefined) {
            expire(rule, state, event.ts - rule.windowMs);
          }
          let mask = 0;
          for (let i = 0; i < k; i++) {
            if (matchesStage(event, rule.stages[i]!)) mask |= 1 << i;
          }
          if (mask === 0) continue;
          if ((mask >> (k - 1)) & 1) {
            // Chains ending at this event = chains of stages 1..k-1 already
            // inside the window (all strictly before this event).
            const agg = state === undefined ? null : windowAggregate(rule, state);
            const count = agg === null ? 0n : agg[idx(rule, 0, k - 1)]!;
            if (count > 0n) {
              hits.push({
                ruleId: rule.ruleId,
                agentId: event.agentId,
                eventId: event.eventId,
                count: count.toString(10),
              });
            }
          }
          if (state === undefined) {
            state = { front: [], back: [] };
            rule.agents.set(event.agentId, state);
          }
          const lf = leaf(rule, mask);
          const backTop = state.back[state.back.length - 1];
          const agg = backTop === undefined ? lf : compose(rule, backTop.agg, lf);
          state.back.push({ ts: event.ts, mask, agg });
        }
      }
      return hits;
    },

    advanceTo(t: number): void {
      setTime(t);
      const now = currentTime!;
      for (const rule of ruleStates) {
        for (const [agentId, state] of rule.agents) {
          expire(rule, state, now - rule.windowMs);
          if (state.front.length === 0 && state.back.length === 0) {
            rule.agents.delete(agentId);
          }
        }
      }
    },
  };
}
