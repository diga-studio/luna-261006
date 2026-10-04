import type { Clock, CancelTimer } from "./clock.js";

/** Maximum bytes delivered by a single `write` call. */
export const MAX_WRITE_BYTES = 1024;
/** Burst capacity of each profile's token bucket, in bytes. */
export const BURST_BYTES = 4096;

const EPSILON = 1e-6;

/** Rejection reason used for `done` when a transfer is cancelled. */
export class CancelledError extends Error {
  constructor(message = "transfer cancelled") {
    super(message);
    this.name = "CancelledError";
  }
}

/** Handle for one shaped transfer. */
export interface TransferHandle {
  /** Resolves once every byte has been delivered in order and the last write completed.
   *  Rejects with CancelledError on cancel, or with the source/write failure. */
  readonly done: Promise<void>;
  /** Immediately terminates this transfer; never waits for pending promises. */
  cancel(): void;
}

/** Async iterable producing Uint8Array chunks of 1..65536 bytes. */
export type ByteSource = AsyncIterable<Uint8Array>;

/** Sink for shaped bytes; the returned Promise signals backpressure. */
export type WriteFn = (chunk: Uint8Array) => Promise<unknown>;

/** Bandwidth shaper: per-profile token buckets shared by all transfers of that profile. */
export interface Shaper {
  start(profileId: string, source: ByteSource, write: WriteFn): TransferHandle;
}

interface ProfileState {
  /** Tokens per millisecond (R / 1000). */
  readonly ratePerMs: number;
  tokens: number;
  lastRefill: number;
  /** Live transfers of this profile (for join baselines). */
  readonly transfers: Set<TransferState>;
  /** FIFO of transfers that have buffered bytes and no pending next/write. */
  readonly ready: TransferState[];
  timer: CancelTimer | null;
  pumping: boolean;
}

interface TransferState {
  readonly profile: ProfileState;
  readonly iterator: AsyncIterator<Uint8Array>;
  readonly writeFn: WriteFn;
  buffer: Uint8Array | null;
  offset: number;
  /** Bytes handed to write so far; drives byte-fair scheduling. */
  sent: number;
  settled: boolean;
  readonly resolveDone: () => void;
  readonly rejectDone: (err: unknown) => void;
}

/**
 * Creates a shaper. `ratesBytesPerSecond` maps profileId -> R (bytes/second),
 * fixed for the lifetime of the shaper. Profiles are independent; all
 * transfers of one profile share that profile's R.
 */
export function createShaper(
  clock: Clock,
  ratesBytesPerSecond: Readonly<Record<string, number>>,
): Shaper {
  const profiles = new Map<string, ProfileState>();
  for (const [id, rate] of Object.entries(ratesBytesPerSecond)) {
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new RangeError(`invalid rate for profile "${id}": ${rate}`);
    }
    profiles.set(id, {
      ratePerMs: rate / 1000,
      tokens: BURST_BYTES,
      lastRefill: clock.now(),
      transfers: new Set(),
      ready: [],
      timer: null,
      pumping: false,
    });
  }

  function refill(profile: ProfileState): void {
    const now = clock.now();
    if (now > profile.lastRefill) {
      // Capped at BURST_BYTES: long idle or clock jumps never bank more than one burst.
      profile.tokens = Math.min(
        BURST_BYTES,
        profile.tokens + (now - profile.lastRefill) * profile.ratePerMs,
      );
      profile.lastRefill = now;
    }
    const rounded = Math.round(profile.tokens);
    if (Math.abs(profile.tokens - rounded) < 1e-9) profile.tokens = rounded;
  }

  function cancelTimer(profile: ProfileState): void {
    if (profile.timer !== null) {
      profile.timer();
      profile.timer = null;
    }
  }

  function removeFromReady(t: TransferState): void {
    const idx = t.profile.ready.indexOf(t);
    if (idx >= 0) t.profile.ready.splice(idx, 1);
  }

  function settle(t: TransferState, error: unknown): void {
    if (t.settled) return;
    t.settled = true;
    t.buffer = null;
    removeFromReady(t);
    t.profile.transfers.delete(t);
    if (error === undefined) t.resolveDone();
    else t.rejectDone(error);
    // Re-evaluate scheduling: a pending timer may have existed only for t.
    pump(t.profile);
  }

  function enqueueReady(t: TransferState): void {
    if (t.settled) return;
    t.profile.ready.push(t);
  }

  function pull(t: TransferState): void {
    // At most one outstanding next/write per transfer: pull is only reached
    // when the previous buffer was fully written and its write completed.
    let result: Promise<IteratorResult<Uint8Array>>;
    try {
      result = Promise.resolve(t.iterator.next());
    } catch (err) {
      settle(t, err);
      return;
    }
    result.then(
      (res) => {
        if (t.settled) return; // late completion must not revive the transfer
        if (res.done) {
          settle(t, undefined);
          return;
        }
        const chunk = res.value;
        if (
          !(chunk instanceof Uint8Array) ||
          chunk.length < 1 ||
          chunk.length > 65536
        ) {
          settle(t, new Error("source produced an invalid chunk"));
          return;
        }
        t.buffer = chunk;
        t.offset = 0;
        enqueueReady(t);
        pump(t.profile);
      },
      (err) => settle(t, err),
    );
  }

  function issueWrite(t: TransferState, bytes: number): void {
    const buffer = t.buffer as Uint8Array;
    const chunk = buffer.subarray(t.offset, t.offset + bytes);
    t.offset += bytes;
    t.buffer = t.offset >= buffer.length ? null : buffer;
    let result: Promise<unknown>;
    try {
      result = Promise.resolve(t.writeFn(chunk));
    } catch (err) {
      settle(t, err);
      return;
    }
    result.then(
      () => {
        if (t.settled) return; // late completion must not revive the transfer
        if (t.buffer !== null) {
          enqueueReady(t);
          pump(t.profile);
        } else {
          pull(t);
        }
      },
      (err) => settle(t, err),
    );
  }

  function pump(profile: ProfileState): void {
    if (profile.pumping) return;
    profile.pumping = true;
    try {
      for (;;) {
        if (profile.ready.length === 0) {
          cancelTimer(profile); // no work: never leave a spinning timer behind
          return;
        }
        refill(profile);
        // Byte-fair: serve the ready transfer with the fewest bytes sent;
        // FIFO order breaks ties. Other transfers never wait on a peer's
        // pending next/write (those are simply not in the ready queue).
        let pick = profile.ready[0] as TransferState;
        for (const candidate of profile.ready) {
          if (candidate.sent < pick.sent) pick = candidate;
        }
        const remaining = (pick.buffer as Uint8Array).length - pick.offset;
        const bytes = Math.min(MAX_WRITE_BYTES, remaining);
        if (profile.tokens + EPSILON < bytes) {
          // Not enough budget for the fairest transfer: wait for exactly the
          // missing tokens with a one-shot timer. Waiting never wastes budget
          // (bytes <= MAX_WRITE_BYTES < BURST_BYTES, so tokens cannot cap out).
          cancelTimer(profile);
          const delayMs = (bytes - profile.tokens) / profile.ratePerMs;
          profile.timer = clock.setTimeout(() => {
            profile.timer = null;
            pump(profile);
          }, delayMs);
          return;
        }
        profile.tokens = Math.max(0, profile.tokens - bytes);
        removeFromReady(pick);
        pick.sent += bytes; // charged at write-call time, not completion time
        issueWrite(pick, bytes);
      }
    } finally {
      profile.pumping = false;
    }
  }

  return {
    start(profileId: string, source: ByteSource, write: WriteFn): TransferHandle {
      const profile = profiles.get(profileId);
      if (profile === undefined) {
        throw new RangeError(`unknown profileId: ${profileId}`);
      }
      if (source == null || typeof source[Symbol.asyncIterator] !== "function") {
        throw new TypeError("source must be an async iterable of Uint8Array");
      }
      if (typeof write !== "function") {
        throw new TypeError("write must be a function");
      }

      let resolveDone!: () => void;
      let rejectDone!: (err: unknown) => void;
      const done = new Promise<void>((resolve, reject) => {
        resolveDone = resolve;
        rejectDone = reject;
      });

      // New transfers join at the current maximum so they never replay
      // traffic that happened before they joined.
      let baseline = 0;
      for (const other of profile.transfers) {
        if (other.sent > baseline) baseline = other.sent;
      }

      const t: TransferState = {
        profile,
        iterator: source[Symbol.asyncIterator](),
        writeFn: write,
        buffer: null,
        offset: 0,
        sent: baseline,
        settled: false,
        resolveDone,
        rejectDone,
      };
      profile.transfers.add(t);
      pull(t);

      return {
        done,
        cancel(): void {
          settle(t, new CancelledError());
        },
      };
    },
  };
}
