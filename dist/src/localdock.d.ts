import type { DeploymentHandle, ServiceConfig, ServiceName, ServiceStatus, WorkUnitFactory } from "./types";
export declare class LocalDock {
    private readonly runtimes;
    deploy(name: ServiceName, config: ServiceConfig, factory: WorkUnitFactory): DeploymentHandle;
    submit(name: ServiceName, request: unknown): Promise<unknown>;
    stop(name: ServiceName): Promise<void>;
    status(name: ServiceName): ServiceStatus;
    private runtimeFor;
}
