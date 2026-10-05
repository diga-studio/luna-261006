export type ServiceName = string;

export type ServiceConfig = unknown;

export interface WorkUnit {
  handleRequest(request: unknown): Promise<unknown>;
  terminate(): Promise<void>;
}

export interface WorkUnitContext {
  notifyReady(): void;
  notifyFailed(error: unknown): void;
  notifyExited(error?: unknown): void;
}

export type WorkUnitFactory = (context: WorkUnitContext) => WorkUnit;

export type DeploymentResult =
  | { readonly kind: "active" }
  | { readonly kind: "failed"; readonly error: unknown }
  | { readonly kind: "superseded" }
  | { readonly kind: "stopped" };

export interface DeploymentHandle {
  readonly id: string;
  readonly result: Promise<DeploymentResult>;
}

export interface VersionInfo {
  readonly deploymentId: string;
  readonly config: ServiceConfig;
  readonly inflight: number;
}

export interface ServiceStatus {
  readonly serving: boolean;
  readonly active?: VersionInfo;
  readonly preparing?: { readonly deploymentId: string };
}
