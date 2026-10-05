export interface StageSpec {
  readonly eventType: string;
  readonly payloadEquals?: Readonly<Record<string, string>>;
}

export interface RuleSpec {
  readonly ruleId: string;
  readonly windowMs: number;
  readonly stages: readonly StageSpec[];
}

export interface TelemetryEvent {
  readonly eventId: string;
  readonly agentId: string;
  readonly ts: number;
  readonly eventType: string;
  readonly payload?: Readonly<Record<string, unknown>>;
}

export interface HitSummary {
  readonly ruleId: string;
  readonly agentId: string;
  readonly eventId: string;
  readonly count: string;
}

export interface Detector {
  ingest(events: readonly TelemetryEvent[]): HitSummary[];
  advanceTo(t: number): void;
}
