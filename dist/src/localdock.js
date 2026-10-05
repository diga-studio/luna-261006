"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LocalDock = void 0;
const service_runtime_1 = require("./service-runtime");
class LocalDock {
    runtimes = new Map();
    deploy(name, config, factory) {
        return this.runtimeFor(name).deploy(config, factory);
    }
    submit(name, request) {
        return this.runtimeFor(name).submit(request);
    }
    stop(name) {
        return this.runtimeFor(name).stop();
    }
    status(name) {
        return this.runtimeFor(name).status();
    }
    runtimeFor(name) {
        let runtime = this.runtimes.get(name);
        if (!runtime) {
            runtime = new service_runtime_1.ServiceRuntime();
            this.runtimes.set(name, runtime);
        }
        return runtime;
    }
}
exports.LocalDock = LocalDock;
