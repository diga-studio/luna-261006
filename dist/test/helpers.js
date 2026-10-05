"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FakeFactory = exports.FakeUnit = void 0;
exports.deferred = deferred;
exports.tick = tick;
exports.settle = settle;
function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}
function tick() {
    return new Promise((resolve) => setImmediate(resolve));
}
async function settle() {
    for (let i = 0; i < 5; i += 1) {
        await tick();
    }
}
class FakeUnit {
    context;
    terminateCalls = 0;
    requests = [];
    terminateImpl = () => Promise.resolve();
    constructor(context) {
        this.context = context;
    }
    handleRequest(request) {
        const entry = { request, deferred: deferred() };
        this.requests.push(entry);
        return entry.deferred.promise;
    }
    terminate() {
        this.terminateCalls += 1;
        return this.terminateImpl();
    }
}
exports.FakeUnit = FakeUnit;
class FakeFactory {
    units = [];
    factory = (context) => {
        const unit = new FakeUnit(context);
        this.units.push(unit);
        return unit;
    };
    get last() {
        const unit = this.units[this.units.length - 1];
        if (!unit) {
            throw new Error("no unit created yet");
        }
        return unit;
    }
}
exports.FakeFactory = FakeFactory;
