/**
 * Public types for LocalDock, an in-process service hot-swap manager.
 *
 * The caller provides service configuration and business work units.
 * LocalDock owns lifecycle state while the platform process runs.
 */

/**
 * A business work unit: an in-process async task provided by the caller.
 * Each deployment produces an independent work unit, even for identical
 * configuration.
 */
export interface WorkUnit {
  /**
   * Handle one admitted request. The returned promise settles when the
   * request completes. Requests are never moved between units and never
   * retried automatically.
   */
  handleRequest(request: unknown): Promise<unknown>;
  /**
   * Request termination. Called by LocalDock at most once per work unit.
   * May be called before the unit signalled readiness. The returned promise
   * resolves when the unit has fully terminated.
   */
  terminate(): Promise<void>;
}

/**
 * Lifecycle notification channel handed to the work-unit factory.
 * Notifications may arrive out of order, late, or duplicated; LocalDock
 * tolerates that.
 */
export interface WorkUnitLifecycle {
  /** The work unit finished preparing and is able to serve requests. */
  notifyReady(): void;
  /**
   * The work unit exited on its own. Before readiness this means the
   * deployment failed; after readiness it is an unexpected exit and fails
   * the unit's unfinished requests.
   */
  notifyExited(error?: unknown): void;
}

/**
 * Factory creating one work unit per deployment. Receives the service
 * configuration given to {@link LocalDock.deploy} and the lifecycle
 * notification channel for this deployment's work unit.
 */
export type WorkUnitFactory = (
  config: unknown,
  lifecycle: WorkUnitLifecycle,
) => WorkUnit;

/** Handle returned by {@link LocalDock.deploy}. */
export interface DeployHandle {
  /** Monotonic version number of this deployment within its service. */
  readonly version: number;
  /**
   * Settles when this deployment's fate is decided: resolves once this
   * version takes over traffic, rejects if the deployment fails, is
   * superseded by a newer deployment, or is invalidated by a stop.
   */
  readonly settled: Promise<void>;
}

export type ServicePhase =
  | 'serving' // a ready version is accepting traffic
  | 'preparing' // no serving version, but the latest deployment is preparing
  | 'unavailable' // no serving version and nothing valid is preparing
  | 'stopped'; // explicitly stopped and not re-deployed since

export interface ServiceStatus {
  readonly phase: ServicePhase;
  /** Version currently serving traffic, if any. Never an unready or
   * terminated version. */
  readonly activeVersion: number | null;
  /** Requests admitted by the active version that have not completed. */
  readonly inflightRequests: number;
}
