import type { WorkUnit, WorkUnitContext, WorkUnitFactory } from "../src/index";
export interface Deferred<T> {
    readonly promise: Promise<T>;
    resolve(value: T | PromiseLike<T>): void;
    reject(error?: unknown): void;
}
export declare function deferred<T>(): Deferred<T>;
export declare function tick(): Promise<void>;
export declare function settle(): Promise<void>;
export interface FakeRequest {
    readonly request: unknown;
    readonly deferred: Deferred<unknown>;
}
export declare class FakeUnit implements WorkUnit {
    readonly context: WorkUnitContext;
    terminateCalls: number;
    readonly requests: FakeRequest[];
    terminateImpl: () => Promise<void>;
    constructor(context: WorkUnitContext);
    handleRequest(request: unknown): Promise<unknown>;
    terminate(): Promise<void>;
}
export declare class FakeFactory {
    readonly units: FakeUnit[];
    readonly factory: WorkUnitFactory;
    get last(): FakeUnit;
}
