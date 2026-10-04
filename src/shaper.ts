import { Clock } from './clock';

/** Result of a finished transfer. `done` never rejects. */
export type TransferResult =
  | { status: 'completed' }
  | { status: 'cancelled' }
  | { status: 'failed'; reason: unknown };

/** Handle returned by {@link Shaper.start}. */
export interface TransferHandle {
  /**
   * Resolves exactly once:
   *  - 'completed' only after every byte was delivered in order and the
   *    final `write` promise resolved;
   *  - 'cancelled' as soon as `cancel()` takes effect (never waits for
   *    dangling promises);
   *  - 'failed' when the source or the sink errors.
   */
  readonly done: Promise<TransferResult>;
  /**
   * Immediately terminates this transfer. After `cancel()` returns, the
   * transfer's `next`/`write` are never invoked again. Already-issued
   * writes are not revoked.
   */
  cancel(): void;
}

/** Async source of response-body chunks (1..65536 bytes each). */
export type ChunkSource = AsyncIterable<Uint8Array>;

/** Sink for shaped chunks. Must not be called concurrently per transfer. */
export type ChunkWriter = (chunk: Uint8Array) => Promise<unknown>;

export interface ShaperOptions {
  /** Sustained rate per profile in bytes/second. Immutable at runtime. */
  readonly rates: Readonly<Record<string, number>>;
  readonly clock: Clock;
}

export interface Shaper {
  start(
    profileId: string,
    source: ChunkSource,
    write: ChunkWriter,
  ): TransferHandle;
}

/** Bucket capacity: max burst after idle, in bytes. */
const BURST_BYTES = 4096;
/** Max bytes per write call; also the fairness quantum. */
const QUANTUM_BYTES = 1024;
/** Max input chunk size accepted from a source. */
const MAX_CHUNK_BYTES = 65536;

type TransferState = 'active' | 'completed' | 'cancelled' | 'failed';

class Transfer {
  state: TransferState = 'active';
  chunk: Uint8Array | null = null;
  offset = 0;
  pulling = false;
  writePending = false;
  /** Clock time when the transfer last became non-ready; null while ready. */
  nonReadySince: number | null = null;
  /** Fairness key: bytes written, offset at join so new streams don't catch up. */
  key = 0;
  readonly iterator: AsyncIterator<Uint8Array>;
  private resolveDone!: (result: TransferResult) => void;
  readonly done: Promise<TransferResult>;

  constructor(
    readonly profile: ProfileState,
    source: ChunkSource,
    readonly writeFn: ChunkWriter,
  ) {
    this.iterator = source[Symbol.asyncIterator]();
    this.done = new Promise<TransferResult>((resolve) => {
      this.resolveDone = resolve;
    });
  }

  get ready(): boolean {
    return (
      this.state === 'active' &&
      this.chunk !== null &&
      this.offset < this.chunk.length &&
      !this.writePending &&
      !this.pulling
    );
  }

  get remaining(): number {
    return this.chunk === null ? 0 : this.chunk.length - this.offset;
  }

  settle(result: TransferResult): void {
    if (this.state !== 'active') return;
    this.state =
      result.status === 'completed'
        ? 'completed'
        : result.status === 'cancelled'
          ? 'cancelled'
          : 'failed';
    this.profile.transfers.delete(this);
    this.resolveDone(result);
  }
}

class ProfileState {
  readonly transfers = new Set<Transfer>();
  /** Available tokens in bytes, capped at BURST_BYTES. */
  tokens = BURST_BYTES;
  lastRefill: number;
  /** Cancel function of the pending one-shot timer, if any. */
  private cancelTimer: (() => void) | null = null;

  constructor(
    readonly rateBytesPerMs: number,
    readonly clock: Clock,
  ) {
    this.lastRefill = clock.now();
  }

  clearTimer(): void {
    if (this.cancelTimer !== null) {
      this.cancelTimer();
      this.cancelTimer = null;
    }
  }

  scheduleTimer(deadline: number): void {
    this.clearTimer();
    const delay = Math.max(0, deadline - this.clock.now());
    this.cancelTimer = this.clock.setTimeout(() => {
      this.cancelTimer = null;
      activate(this);
    }, delay);
  }
}

function refill(profile: ProfileState, now: number): void {
  const elapsed = now - profile.lastRefill;
  if (elapsed > 0) {
    profile.tokens = Math.min(
      BURST_BYTES,
      profile.tokens + elapsed * profile.rateBytesPerMs,
    );
    profile.lastRefill = now;
  }
}

/** A non-ready transfer still counts for fairness while its clock has not moved. */
function isFresh(transfer: Transfer, now: number): boolean {
  return (
    transfer.ready ||
    (transfer.nonReadySince !== null && transfer.nonReadySince >= now)
  );
}

function maxActiveKey(profile: ProfileState, except?: Transfer): number {
  let max = 0;
  for (const other of profile.transfers) {
    if (other.state === 'active' && other !== except && other.key > max) {
      max = other.key;
    }
  }
  return max;
}

/**
 * When a transfer becomes ready after the clock moved while it was
 * non-ready (e.g. a hung `next`/`write`), rebase its key so it rejoins
 * like a new stream instead of hogging bandwidth to catch up.
 */
function rejoinIfStale(transfer: Transfer, now: number): void {
  if (transfer.nonReadySince !== null && transfer.nonReadySince < now) {
    transfer.key = Math.max(transfer.key, maxActiveKey(transfer.profile, transfer));
  }
  transfer.nonReadySince = null;
}

function performWrite(profile: ProfileState, transfer: Transfer, n: number, now: number): void {
  const chunk = transfer.chunk;
  if (chunk === null) return;
  const slice = chunk.subarray(transfer.offset, transfer.offset + n);
  transfer.offset += n;
  transfer.key += n;
  transfer.writePending = true;
  transfer.nonReadySince = now;
  let promise: Promise<unknown>;
  try {
    promise = Promise.resolve(transfer.writeFn(slice));
  } catch (error) {
    settleTransfer(transfer, { status: 'failed', reason: error });
    return;
  }
  promise.then(
    () => onWriteResolved(transfer),
    (error) => settleTransfer(transfer, { status: 'failed', reason: error }),
  );
}

function onWriteResolved(transfer: Transfer): void {
  if (transfer.state !== 'active') return;
  transfer.writePending = false;
  const now = transfer.profile.clock.now();
  if (transfer.chunk !== null && transfer.offset >= transfer.chunk.length) {
    transfer.chunk = null;
    startPull(transfer, now);
  } else {
    rejoinIfStale(transfer, now);
  }
  activate(transfer.profile);
}

function startPull(transfer: Transfer, now: number): void {
  transfer.pulling = true;
  transfer.nonReadySince = now;
  let promise: Promise<IteratorResult<Uint8Array>>;
  try {
    promise = Promise.resolve(transfer.iterator.next());
  } catch (error) {
    settleTransfer(transfer, { status: 'failed', reason: error });
    return;
  }
  promise.then(
    (result) => onPullResolved(transfer, result),
    (error) => settleTransfer(transfer, { status: 'failed', reason: error }),
  );
}

function onPullResolved(transfer: Transfer, result: IteratorResult<Uint8Array>): void {
  if (transfer.state !== 'active') return;
  transfer.pulling = false;
  if (result.done) {
    settleTransfer(transfer, { status: 'completed' });
    return;
  }
  const value = result.value;
  if (
    !(value instanceof Uint8Array) ||
    value.length < 1 ||
    value.length > MAX_CHUNK_BYTES
  ) {
    settleTransfer(transfer, {
      status: 'failed',
      reason: new Error(
        'source chunk must be a Uint8Array of 1..65536 bytes',
      ),
    });
    return;
  }
  transfer.chunk = value;
  transfer.offset = 0;
  rejoinIfStale(transfer, transfer.profile.clock.now());
  activate(transfer.profile);
}

function settleTransfer(transfer: Transfer, result: TransferResult): void {
  transfer.settle(result);
  activate(transfer.profile);
}

/**
 * Drain currently writable work for a profile, then (re)arm its timer.
 *
 * Serving rule: always pick the ready transfer with the smallest fairness
 * key, and never let any transfer run more than QUANTUM_BYTES ahead of the
 * smallest key among freshly-active transfers. A transfer that is
 * momentarily non-ready (its `next`/`write` was issued at the current
 * instant) still pins the minimum key; once the clock moves past that
 * instant it is treated as stalled and stops throttling others.
 */
function activate(profile: ProfileState): void {
  const now = profile.clock.now();
  refill(profile, now);

  for (;;) {
    let minFreshKey = Infinity;
    for (const transfer of profile.transfers) {
      if (transfer.state === 'active' && isFresh(transfer, now)) {
        if (transfer.key < minFreshKey) minFreshKey = transfer.key;
      }
    }
    let pick: Transfer | null = null;
    for (const transfer of profile.transfers) {
      if (!transfer.ready) continue;
      if (pick === null || transfer.key < pick.key) pick = transfer;
    }
    if (pick === null) break;
    const allowance = minFreshKey + QUANTUM_BYTES - pick.key;
    if (allowance < 1) break;
    const n = Math.min(allowance, pick.remaining, Math.floor(profile.tokens));
    if (n < 1) break;
    profile.tokens -= n;
    performWrite(profile, pick, n, now);
  }

  profile.clearTimer();
  let deadline = Infinity;
  let hasReady = false;
  let staleDeadline = Infinity;
  for (const transfer of profile.transfers) {
    if (transfer.state !== 'active') continue;
    if (transfer.ready) {
      hasReady = true;
    } else if (transfer.nonReadySince !== null && transfer.nonReadySince >= now) {
      staleDeadline = Math.min(staleDeadline, transfer.nonReadySince + 1);
    }
  }
  if (hasReady) {
    if (profile.tokens < 1) {
      // Wake when a full quantum of tokens has accrued; tiny-chunk streams
      // drain it through immediate re-activations at the same instant.
      deadline = Math.min(
        deadline,
        now + (QUANTUM_BYTES - profile.tokens) / profile.rateBytesPerMs,
      );
    }
    if (staleDeadline !== Infinity) {
      // A freshly non-ready transfer is throttling ready ones; re-check
      // once it goes stale so hung streams cannot block the profile.
      deadline = Math.min(deadline, staleDeadline);
    }
  }
  if (deadline !== Infinity) {
    profile.scheduleTimer(deadline);
  }
}

class ShaperImpl implements Shaper {
  private readonly profiles = new Map<string, ProfileState>();
  private readonly rates: Readonly<Record<string, number>>;
  private readonly clock: Clock;

  constructor(options: ShaperOptions) {
    this.clock = options.clock;
    this.rates = options.rates;
    for (const [profileId, rate] of Object.entries(options.rates)) {
      if (!Number.isFinite(rate) || rate <= 0) {
        throw new Error(`invalid rate for profile "${profileId}": ${rate}`);
      }
    }
  }

  start(profileId: string, source: ChunkSource, write: ChunkWriter): TransferHandle {
    const rate = this.rates[profileId];
    if (rate === undefined) {
      throw new Error(`unknown profileId: ${profileId}`);
    }
    let profile = this.profiles.get(profileId);
    if (profile === undefined) {
      profile = new ProfileState(rate / 1000, this.clock);
      this.profiles.set(profileId, profile);
    }
    const transfer = new Transfer(profile, source, write);
    // New streams join at the current maximum key: no catch-up of
    // traffic that flowed before they joined.
    transfer.key = maxActiveKey(profile);
    profile.transfers.add(transfer);
    const now = this.clock.now();
    startPull(transfer, now);
    activate(profile);
    return {
      done: transfer.done,
      cancel: () => {
        settleTransfer(transfer, { status: 'cancelled' });
      },
    };
  }
}

export function createShaper(options: ShaperOptions): Shaper {
  return new ShaperImpl(options);
}
