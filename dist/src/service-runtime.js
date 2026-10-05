"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ServiceRuntime = void 0;
class ServiceRuntime {
    deployments = new Map();
    activeId = null;
    deploySeq = 0;
    requestSeq = 0;
    deploy(config, factory) {
        this.deploySeq += 1;
        const id = `d${this.deploySeq}`;
        for (const record of this.deployments.values()) {
            if (record.state === "preparing") {
                record.resolveResult({ kind: "superseded" });
                this.requestTerminate(record);
            }
        }
        let resolveResult;
        let resolveDone;
        const record = {
            id,
            config,
            unit: undefined,
            state: "preparing",
            inflight: 0,
            terminateRequested: false,
            pending: new Map(),
            result: new Promise((resolve) => {
                resolveResult = resolve;
            }),
            resolveResult,
            done: new Promise((resolve) => {
                resolveDone = resolve;
            }),
            resolveDone,
        };
        this.deployments.set(id, record);
        const context = {
            notifyReady: () => this.dispatch(record, () => this.onReady(record)),
            notifyFailed: (error) => this.dispatch(record, () => this.onFailed(record, error)),
            notifyExited: (error) => this.dispatch(record, () => this.onExited(record, error)),
        };
        let unit;
        try {
            unit = factory(context);
        }
        catch (error) {
            record.resolveResult({ kind: "failed", error });
            record.state = "done";
            record.resolveDone();
            return { id, result: record.result };
        }
        record.unit = unit;
        return { id, result: record.result };
    }
    dispatch(record, action) {
        if (record.unit === undefined && record.state === "preparing") {
            queueMicrotask(() => this.dispatch(record, action));
            return;
        }
        action();
    }
    onReady(record) {
        if (record.state !== "preparing") {
            return;
        }
        const previous = this.activeId
            ? this.deployments.get(this.activeId)
            : undefined;
        this.activeId = record.id;
        record.state = "active";
        record.resolveResult({ kind: "active" });
        if (previous && previous.state === "active") {
            previous.state = "draining";
            this.maybeTerminate(previous);
        }
    }
    onFailed(record, error) {
        if (record.state !== "preparing") {
            return;
        }
        record.resolveResult({ kind: "failed", error });
        this.requestTerminate(record);
    }
    onExited(record, error) {
        if (record.state === "done" || record.state === "closing") {
            return;
        }
        const failure = error instanceof Error ? error : new Error("work unit exited");
        const rejects = [...record.pending.values()];
        record.pending.clear();
        record.inflight = 0;
        if (record.state === "active" && this.activeId === record.id) {
            this.activeId = null;
        }
        if (record.state === "preparing") {
            record.resolveResult({ kind: "failed", error: failure });
        }
        record.state = "done";
        record.resolveDone();
        for (const reject of rejects) {
            reject(failure);
        }
    }
    maybeTerminate(record) {
        if (record.state === "draining" && record.inflight === 0) {
            this.requestTerminate(record);
        }
    }
    requestTerminate(record) {
        if (record.terminateRequested || record.state === "done") {
            return;
        }
        record.terminateRequested = true;
        record.state = "closing";
        const unit = record.unit;
        if (!unit) {
            record.state = "done";
            record.resolveDone();
            return;
        }
        Promise.resolve()
            .then(() => unit.terminate())
            .then(() => {
            record.state = "done";
            record.resolveDone();
        }, () => {
            record.state = "done";
            record.resolveDone();
        });
    }
    submit(request) {
        const active = this.activeId
            ? this.deployments.get(this.activeId)
            : undefined;
        if (!active || active.state !== "active" || !active.unit) {
            return Promise.reject(new Error("service unavailable"));
        }
        const record = active;
        const unit = active.unit;
        record.inflight += 1;
        this.requestSeq += 1;
        const key = this.requestSeq;
        return new Promise((resolve, reject) => {
            let settled = false;
            const settle = () => {
                if (settled) {
                    return;
                }
                settled = true;
                if (record.pending.delete(key)) {
                    record.inflight -= 1;
                    this.maybeTerminate(record);
                }
            };
            record.pending.set(key, (error) => {
                settle();
                reject(error);
            });
            let outcome;
            try {
                outcome = Promise.resolve(unit.handleRequest(request));
            }
            catch (error) {
                outcome = Promise.reject(error);
            }
            outcome.then((value) => {
                settle();
                resolve(value);
            }, (error) => {
                settle();
                reject(error);
            });
        });
    }
    async stop() {
        const affected = [...this.deployments.values()].filter((record) => record.state !== "done");
        if (this.activeId) {
            const active = this.deployments.get(this.activeId);
            this.activeId = null;
            if (active && active.state === "active") {
                active.state = "draining";
                this.maybeTerminate(active);
            }
        }
        for (const record of affected) {
            if (record.state === "preparing") {
                record.resolveResult({ kind: "stopped" });
                this.requestTerminate(record);
            }
        }
        await Promise.all(affected.map((record) => record.done));
    }
    status() {
        const active = this.activeId
            ? this.deployments.get(this.activeId)
            : undefined;
        const serving = !!active && active.state === "active";
        const preparing = [...this.deployments.values()].find((record) => record.state === "preparing");
        return {
            serving,
            ...(serving && active
                ? {
                    active: {
                        deploymentId: active.id,
                        config: active.config,
                        inflight: active.inflight,
                    },
                }
                : {}),
            ...(preparing ? { preparing: { deploymentId: preparing.id } } : {}),
        };
    }
}
exports.ServiceRuntime = ServiceRuntime;
