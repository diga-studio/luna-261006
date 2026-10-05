import { ServiceRuntime } from "./service-runtime";
import type {
  DeploymentHandle,
  ServiceConfig,
  ServiceName,
  ServiceStatus,
  WorkUnitFactory,
} from "./types";

export class LocalDock {
  private readonly runtimes = new Map<ServiceName, ServiceRuntime>();

  deploy(
    name: ServiceName,
    config: ServiceConfig,
    factory: WorkUnitFactory,
  ): DeploymentHandle {
    return this.runtimeFor(name).deploy(config, factory);
  }

  submit(name: ServiceName, request: unknown): Promise<unknown> {
    return this.runtimeFor(name).submit(request);
  }

  stop(name: ServiceName): Promise<void> {
    return this.runtimeFor(name).stop();
  }

  status(name: ServiceName): ServiceStatus {
    return this.runtimeFor(name).status();
  }

  private runtimeFor(name: ServiceName): ServiceRuntime {
    let runtime = this.runtimes.get(name);
    if (!runtime) {
      runtime = new ServiceRuntime();
      this.runtimes.set(name, runtime);
    }
    return runtime;
  }
}
