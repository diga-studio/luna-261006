/** A single ordered stage of a detection rule. */
export interface Stage {
  /** Required event type. */
  eventType: string;
  /** Payload string equality conditions; all must hold. Missing fields never match. */
  conditions: Record<string, string>;
}

/** An immutable detection rule (already parsed; no YAML handling here). */
export interface Rule {
  ruleId: string;
  /** Window length in milliseconds. Boundary is inclusive: tsLast - tsFirst <= windowMs. */
  windowMs: number;
  /** 2 to 8 ordered stages. */
  stages: Stage[];
}

/** A telemetry event. eventId is globally unique; events arrive in non-decreasing ts. */
export interface TelemetryEvent {
  eventId: string;
  agentId: string;
  /** Integer millisecond timestamp. */
  ts: number;
  eventType: string;
  payload: Record<string, string>;
}

/** A hit summary produced by ingest for one (rule, ending event) pair. */
export interface HitSummary {
  ruleId: string;
  agentId: string;
  /** eventId of the event matching the final stage. */
  eventId: string;
  /** Exact number of evidence chains ending at this event, as a decimal string. */
  count: string;
}

export interface Detector {
  /**
   * Ingest a batch of events (non-decreasing ts, stable across batches).
   * Returns summaries for hits newly produced by this batch, in processing order.
   */
  ingest(events: TelemetryEvent[]): HitSummary[];
  /**
   * Advance time without new events, expiring stale state. Produces no summaries.
   * Time may only move forward.
   */
  advanceTo(t: number): void;
}
