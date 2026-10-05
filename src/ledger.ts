import { AgingReport, Batch } from "./types";
import { parseDate } from "./date";
import { combineUnits, formatUnits, parseAmount, splitUnits } from "./money";

/**
 * Internal design notes.
 *
 * Every invoice, payment and reversal becomes one "event" carrying a signed
 * amount (invoice: +amount at its invoice date, payment: -amount, reversal:
 * +amount) plus the invoice's due day and currency. For a report date D the
 * five bucket boundaries only depend on D through the thresholds
 * due <= D - c for c in {1, 31, 61, 91} (plus "any due" for the total), so
 * each event gets five sort keys:
 *
 *   key[0] = date                      (total: date <= D)
 *   key[1] = max(date, due + 1)        (due <= D - 1  <=>  key <= D)
 *   key[2] = max(date, due + 31)       (due <= D - 31)
 *   key[3] = max(date, due + 61)       (due <= D - 61)
 *   key[4] = max(date, due + 91)       (due <= D - 91)
 *
 * If G[j] is the sum of signed amounts of visible events with key[j] <= D,
 * the buckets are: current = G0-G1, 1-30 = G1-G2, 31-60 = G2-G3,
 * 61-90 = G3-G4, 90+ = G4.
 *
 * Events are appended in revision order. Consecutive revisions are sealed
 * into immutable blocks; each block stores, per (currency, key slot), the
 * event keys sorted ascending with prefix sums, so a fully visible block is
 * answered with binary searches. The block straddling the queried revision
 * is answered by scanning its (revision-ordered) record prefix, and the
 * unsealed tail of recent records is scanned directly. Scans are bounded by
 * the block size, keeping queries fast regardless of history length.
 */

/** Seal the pending tail once it holds at least this many records. */
const SEAL_TARGET = 4096;
/** A batch with at least this many records becomes a block of its own. */
const BIG_BATCH = 1024;

const KEY_SLOTS = 5;
const DUE_OFFSETS = [0, 1, 31, 61, 91];

interface Rec {
  rev: number;
  curr: number;
  k0: number;
  k1: number;
  k2: number;
  k3: number;
  k4: number;
  hi: number;
  lo: number;
}

interface KeyList {
  keys: Int32Array;
  preHi: Float64Array;
  preLo: Float64Array;
}

interface Block {
  minRev: number;
  maxRev: number;
  /** Per (currency * KEY_SLOTS + slot) sorted key lists with prefix sums. */
  lists: KeyList[];
  /** Records ordered by revision, for prefix scans of partial blocks. */
  recs: Rec[];
  /** revisions[i] = revision number of the i-th record group. */
  revs: Int32Array;
  /** offsets[i] = index in recs where revisions[i]'s records start. */
  offsets: Int32Array;
}

const EMPTY_LIST: KeyList = {
  keys: new Int32Array(0),
  preHi: new Float64Array(1),
  preLo: new Float64Array(1),
};

interface InvoiceInfo {
  curr: number;
  due: number;
}

function upperBound(keys: Int32Array, value: number): number {
  let lo = 0;
  let hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (keys[mid] <= value) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

function buildBlock(revs: Int32Array, offsets: Int32Array, recs: Rec[], currCount: number): Block {
  const slotCount = currCount * KEY_SLOTS;
  const buckets: Rec[][] = new Array(slotCount);
  for (let s = 0; s < slotCount; s++) {
    buckets[s] = [];
  }
  for (const rec of recs) {
    const base = rec.curr * KEY_SLOTS;
    buckets[base].push(rec);
    buckets[base + 1].push(rec);
    buckets[base + 2].push(rec);
    buckets[base + 3].push(rec);
    buckets[base + 4].push(rec);
  }
  const lists: KeyList[] = new Array(slotCount);
  const keyOf = [
    (r: Rec) => r.k0,
    (r: Rec) => r.k1,
    (r: Rec) => r.k2,
    (r: Rec) => r.k3,
    (r: Rec) => r.k4,
  ];
  for (let s = 0; s < slotCount; s++) {
    const recsInSlot = buckets[s];
    if (recsInSlot.length === 0) {
      lists[s] = EMPTY_LIST;
      continue;
    }
    const getKey = keyOf[s % KEY_SLOTS];
    recsInSlot.sort((a, b) => getKey(a) - getKey(b));
    const n = recsInSlot.length;
    const keys = new Int32Array(n);
    const preHi = new Float64Array(n + 1);
    const preLo = new Float64Array(n + 1);
    let sumHi = 0;
    let sumLo = 0;
    for (let i = 0; i < n; i++) {
      const rec = recsInSlot[i];
      keys[i] = getKey(rec);
      sumHi += rec.hi;
      sumLo += rec.lo;
      preHi[i + 1] = sumHi;
      preLo[i + 1] = sumLo;
    }
    lists[s] = { keys, preHi, preLo };
  }
  return {
    minRev: revs.length === 0 ? 0 : revs[0],
    maxRev: revs.length === 0 ? 0 : revs[revs.length - 1],
    lists,
    recs,
    revs,
    offsets,
  };
}

/**
 * In-memory accounts payable aging ledger with revisioned history.
 *
 * - appendBatch applies a whole batch atomically and returns its revision
 *   number (1, 2, 3, ...).
 * - queryAging(reportDate, revision) reproduces the five-bucket aging
 *   summary per visible currency exactly as of that revision; results for
 *   the same arguments never change as more batches are appended.
 */
export class AgingLedger {
  private revision = 0;
  private readonly invoices = new Map<string, InvoiceInfo>();
  private readonly currencyIndex = new Map<string, number>();
  private readonly currencyNames: string[] = [];
  private readonly currencyFirstRev: number[] = [];
  private readonly blocks: Block[] = [];
  private pending: Rec[] = [];
  private pendingRevs: number[] = [];
  private pendingOffsets: number[] = [];
  private accHi: Float64Array = new Float64Array(0);
  private accLo: Float64Array = new Float64Array(0);

  constructor() {
  }

  /** Current highest revision number (0 when empty). */
  get currentRevision(): number {
    return this.revision;
  }

  /** Append a batch; returns the revision number assigned to it. */
  appendBatch(batch: Batch): number {
    const rev = ++this.revision;
    const recs: Rec[] = [];
    for (const inv of batch.invoices ?? []) {
      if (this.invoices.has(inv.id)) {
        throw new Error(`duplicate invoice id "${inv.id}"`);
      }
      const curr = this.registerCurrency(inv.currency);
      const units = parseAmount(inv.amount);
      if (units <= 0n) {
        throw new Error(`invoice "${inv.id}" amount must be positive`);
      }
      const invoiceDate = parseDate(inv.invoiceDate);
      const due = parseDate(inv.dueDate);
      this.invoices.set(inv.id, { curr, due });
      recs.push(makeRec(rev, curr, invoiceDate, due, units));
    }
    for (const pay of batch.payments ?? []) {
      const inv = this.lookupInvoice(pay.invoiceId);
      const units = parseAmount(pay.amount);
      if (units <= 0n) {
        throw new Error(`payment for "${pay.invoiceId}" amount must be positive`);
      }
      const date = parseDate(pay.date);
      recs.push(makeRec(rev, inv.curr, date, inv.due, -units));
    }
    for (const revr of batch.reversals ?? []) {
      const inv = this.lookupInvoice(revr.invoiceId);
      const units = parseAmount(revr.amount);
      if (units <= 0n) {
        throw new Error(`reversal for "${revr.invoiceId}" amount must be positive`);
      }
      const date = parseDate(revr.date);
      recs.push(makeRec(rev, inv.curr, date, inv.due, units));
    }
    if (recs.length === 0) {
      return rev;
    }
    if (recs.length >= BIG_BATCH) {
      this.sealPending();
      const revs = new Int32Array([rev]);
      const offsets = new Int32Array([0]);
      this.blocks.push(buildBlock(revs, offsets, recs, this.currencyNames.length));
      return rev;
    }
    this.pendingOffsets.push(this.pending.length);
    this.pendingRevs.push(rev);
    for (const rec of recs) {
      this.pending.push(rec);
    }
    if (this.pending.length >= SEAL_TARGET) {
      this.sealPending();
    }
    return rev;
  }

  /** Aging summary for a business date as of a visible revision. */
  queryAging(reportDate: string, revision: number): AgingReport {
    const day = parseDate(reportDate);
    if (!Number.isInteger(revision)) {
      throw new Error(`invalid revision ${revision}`);
    }
    const rev = Math.max(0, Math.min(revision, this.revision));
    const currCount = this.currencyNames.length;
    const slotCount = currCount * KEY_SLOTS;
    if (this.accHi.length < slotCount) {
      this.accHi = new Float64Array(slotCount);
      this.accLo = new Float64Array(slotCount);
    } else {
      this.accHi.fill(0, 0, slotCount);
      this.accLo.fill(0, 0, slotCount);
    }
    const accHi = this.accHi;
    const accLo = this.accLo;
    for (const block of this.blocks) {
      if (rev >= block.maxRev) {
        accumulateBlock(accHi, accLo, block, day, currCount);
      } else if (rev >= block.minRev) {
        accumulateBlockPrefix(accHi, accLo, block, rev, day);
        break;
      } else {
        break;
      }
    }
    accumulatePending(accHi, accLo, this.pending, rev, day);
    const currencies: AgingReport["currencies"] = {};
    for (let c = 0; c < currCount; c++) {
      if (this.currencyFirstRev[c] > rev) {
        continue;
      }
      const base = c * KEY_SLOTS;
      const g0 = combineUnits(accHi[base], accLo[base]);
      const g1 = combineUnits(accHi[base + 1], accLo[base + 1]);
      const g2 = combineUnits(accHi[base + 2], accLo[base + 2]);
      const g3 = combineUnits(accHi[base + 3], accLo[base + 3]);
      const g4 = combineUnits(accHi[base + 4], accLo[base + 4]);
      currencies[this.currencyNames[c]] = {
        current: formatUnits(g0 - g1),
        overdue1To30: formatUnits(g1 - g2),
        overdue31To60: formatUnits(g2 - g3),
        overdue61To90: formatUnits(g3 - g4),
        overdue90Plus: formatUnits(g4),
      };
    }
    return { reportDate, revision: rev, currencies };
  }

  private registerCurrency(name: string): number {
    let idx = this.currencyIndex.get(name);
    if (idx === undefined) {
      idx = this.currencyNames.length;
      this.currencyIndex.set(name, idx);
      this.currencyNames.push(name);
      this.currencyFirstRev.push(this.revision);
    }
    return idx;
  }

  private lookupInvoice(id: string): InvoiceInfo {
    const inv = this.invoices.get(id);
    if (inv === undefined) {
      throw new Error(`unknown invoice id "${id}"`);
    }
    return inv;
  }

  private sealPending(): void {
    if (this.pending.length === 0) {
      return;
    }
    const revs = new Int32Array(this.pendingRevs);
    const offsets = new Int32Array(this.pendingOffsets);
    this.blocks.push(buildBlock(revs, offsets, this.pending, this.currencyNames.length));
    this.pending = [];
    this.pendingRevs = [];
    this.pendingOffsets = [];
  }
}

function makeRec(rev: number, curr: number, date: number, due: number, units: bigint): Rec {
  const [hi, lo] = splitUnits(units);
  return {
    rev,
    curr,
    k0: date,
    k1: Math.max(date, due + DUE_OFFSETS[1]),
    k2: Math.max(date, due + DUE_OFFSETS[2]),
    k3: Math.max(date, due + DUE_OFFSETS[3]),
    k4: Math.max(date, due + DUE_OFFSETS[4]),
    hi,
    lo,
  };
}

function accumulateBlock(
  accHi: Float64Array,
  accLo: Float64Array,
  block: Block,
  day: number,
  currCount: number
): void {
  const slots = Math.min(block.lists.length, currCount * KEY_SLOTS);
  for (let s = 0; s < slots; s++) {
    const list = block.lists[s];
    if (list.keys.length === 0) {
      continue;
    }
    const idx = upperBound(list.keys, day);
    accHi[s] += list.preHi[idx];
    accLo[s] += list.preLo[idx];
  }
}

function accumulateBlockPrefix(
  accHi: Float64Array,
  accLo: Float64Array,
  block: Block,
  rev: number,
  day: number
): void {
  // Records are revision-ordered, so visible records form a prefix.
  let lo = 0;
  let hi = block.revs.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (block.revs[mid] <= rev) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  const end = lo === 0 ? 0 : lo === block.revs.length ? block.recs.length : block.offsets[lo];
  accumulateRecs(accHi, accLo, block.recs, 0, end, day);
}

function accumulatePending(
  accHi: Float64Array,
  accLo: Float64Array,
  pending: Rec[],
  rev: number,
  day: number
): void {
  let end = pending.length;
  // Pending records are revision-ordered; find the visible prefix, but a
  // query for an old revision may cut it short.
  while (end > 0 && pending[end - 1].rev > rev) {
    end--;
  }
  accumulateRecs(accHi, accLo, pending, 0, end, day);
}

function accumulateRecs(
  accHi: Float64Array,
  accLo: Float64Array,
  recs: Rec[],
  start: number,
  end: number,
  day: number
): void {
  for (let i = start; i < end; i++) {
    const rec = recs[i];
    const base = rec.curr * KEY_SLOTS;
    if (rec.k0 <= day) {
      accHi[base] += rec.hi;
      accLo[base] += rec.lo;
    }
    if (rec.k1 <= day) {
      accHi[base + 1] += rec.hi;
      accLo[base + 1] += rec.lo;
    }
    if (rec.k2 <= day) {
      accHi[base + 2] += rec.hi;
      accLo[base + 2] += rec.lo;
    }
    if (rec.k3 <= day) {
      accHi[base + 3] += rec.hi;
      accLo[base + 3] += rec.lo;
    }
    if (rec.k4 <= day) {
      accHi[base + 4] += rec.hi;
      accLo[base + 4] += rec.lo;
    }
  }
}
