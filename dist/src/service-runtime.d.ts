import type { DeploymentHandle, ServiceConfig, ServiceStatus, WorkUnitFactory } from "./types";
export declare class ServiceRuntime {
    private readonly deployments;
    private activeId;
    private deploySeq;
    private requestSeq;
    deploy(config: ServiceConfig, factory: WorkUnitFactory): DeploymentHandle;
    private dispatch;
    private onReady;
    private onFailed;
    private onExited;
    private maybeTerminate;
    private requestTerminate;
    submit(request: unknown): Promise<unknown>;
    stop(): Promise<void>;
    status(): ServiceStatus;
}
