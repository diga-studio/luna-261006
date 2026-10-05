/** A single ordered build step within a service. */
export interface StepSpec {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** Per-step timeout in ms, counted from step start. */
  timeoutMs: number;
}

/** A service in the dependency graph. */
export interface ServiceSpec {
  name: string;
  steps: StepSpec[];
}

export interface PipelineRequest {
  /** All services of the graph (in-scope and out-of-scope). */
  services: ServiceSpec[];
  /** service name -> names of services it depends on. Must be acyclic. */
  dependencies: Record<string, string[]>;
  /** Changed services; scope = changed + all transitive dependents. */
  changedServices: string[];
  /** Max number of concurrently running build steps (processes). */
  concurrency: number;
  /** Total pipeline timeout in ms, counted from submission (includes queueing). */
  pipelineTimeoutMs: number;
  /** Grace period after SIGTERM before SIGKILL is sent. Default: no escalation. */
  killGraceMs?: number;
}

export type StepStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'timeout'
  | 'cancelled'
  | 'skipped';

export type ServiceStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'blocked'
  | 'cancelled'
  | 'out-of-scope';

export type PipelineStatus = 'running' | 'succeeded' | 'failed' | 'timeout';

export interface StepSnapshot {
  name: string;
  status: StepStatus;
  exitCode: number | null;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface ServiceSnapshot {
  name: string;
  inScope: boolean;
  status: ServiceStatus;
  steps: StepSnapshot[];
}

export interface PipelineSnapshot {
  id: string;
  status: PipelineStatus;
  slotsTotal: number;
  slotsInUse: number;
  startedAt: number;
  deadlineAt: number;
  services: ServiceSnapshot[];
}

export interface PipelineResult {
  status: Exclude<PipelineStatus, 'running'>;
  startedAt: number;
  finishedAt: number;
  snapshot: PipelineSnapshot;
}

export interface PipelineHandle {
  readonly id: string;
  snapshot(): PipelineSnapshot;
  result(): Promise<PipelineResult>;
}
