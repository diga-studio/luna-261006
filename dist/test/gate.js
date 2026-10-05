"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Signal = exports.Gate = void 0;
/** 可重复使用的闸门：release 前 wait 挂起，release 后 wait 立即通过。 */
class Gate {
    constructor() {
        this.open = false;
        this.waiters = [];
    }
    wait() {
        if (this.open)
            return Promise.resolve();
        return new Promise((resolve) => this.waiters.push(resolve));
    }
    release() {
        this.open = true;
        const waiters = this.waiters;
        this.waiters = [];
        for (const resolve of waiters)
            resolve();
    }
}
exports.Gate = Gate;
/** 手动触发的信号：测试等待“重算已到达暂停点”。 */
class Signal {
    constructor() {
        this.promise = new Promise((resolve) => {
            this.resolveFn = resolve;
        });
    }
    fire() {
        this.resolveFn();
    }
}
exports.Signal = Signal;
