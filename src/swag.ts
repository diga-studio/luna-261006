import type { Summary } from "./monoid.ts";
import { mergeSummaries, zeroSummary } from "./monoid.ts";

interface Slot {
  readonly ts: number;
  readonly self: Summary;
  readonly agg: Summary;
}

// Sliding-window aggregation queue (SWAG) over the summary monoid.
// Push at the back, evict from the front, query the aggregate of all live
// elements. Every operation is amortized O(1) monoid products.
//
// The queue is split into a back stack (inStack, top = newest) and a front
// stack (outStack, top = oldest). Each slot caches the monoid product of its
// stack segment in sequence order, so the aggregate of the whole queue is
// merge(outStack top agg, inStack top agg). Elements migrate from inStack to
// outStack at most once, giving the amortized bound.
export class SlidingWindowAggregator {
  private readonly k: number;
  private readonly zero: Summary;
  private inStack: Slot[] = [];
  private outStack: Slot[] = [];

  constructor(k: number) {
    this.k = k;
    this.zero = zeroSummary(k);
  }

  get size(): number {
    return this.inStack.length + this.outStack.length;
  }

  frontTs(): number | undefined {
    if (this.outStack.length > 0) {
      return this.outStack[this.outStack.length - 1].ts;
    }
    return this.inStack.length > 0 ? this.inStack[0].ts : undefined;
  }

  popFront(): void {
    if (this.outStack.length === 0) {
      this.transfer();
    }
    const slot = this.outStack.pop();
    if (slot === undefined) {
      throw new Error("popFront on empty aggregator");
    }
  }

  push(ts: number, self: Summary): void {
    const top = this.inStack[this.inStack.length - 1];
    const agg = top === undefined ? self : mergeSummaries(this.k, top.agg, self);
    this.inStack.push({ ts, self, agg });
  }

  query(): Summary {
    const outTop = this.outStack[this.outStack.length - 1];
    const inTop = this.inStack[this.inStack.length - 1];
    if (outTop === undefined) {
      return inTop === undefined ? this.zero : inTop.agg;
    }
    if (inTop === undefined) {
      return outTop.agg;
    }
    return mergeSummaries(this.k, outTop.agg, inTop.agg);
  }

  private transfer(): void {
    while (this.inStack.length > 0) {
      const slot = this.inStack.pop() as Slot;
      const top = this.outStack[this.outStack.length - 1];
      const agg =
        top === undefined ? slot.self : mergeSummaries(this.k, slot.self, top.agg);
      this.outStack.push({ ts: slot.ts, self: slot.self, agg });
    }
  }
}
