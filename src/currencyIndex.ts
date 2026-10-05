import { FenwickHistory } from "./fenwick.ts";

/** Target maximum number of invoices per block before splitting. */
const MAX_BLOCK_INVOICES = 128;
/** Rebuild a block's history Fenwick once this many updates are pending. */
const TAIL_LIMIT = 16;

interface InvoiceEvent {
  /** Effective day: max(business day, invoice day), so unbilled invoices self-exclude via the day filter. */
  day: number;
  /** Global event sequence (revision order). */
  seq: number;
  /** Signed scaled weight: payments negative, reversals positive. */
  weight: bigint;
}

interface InvoiceRecord {
  orig: bigint;
  invDay: number;
  dueDay: number;
  revision: number;
  block: Block;
  events: InvoiceEvent[];
  /** Precomputed event summaries for O(1) balance resolution. */
  minSeq: number;
  maxSeq: number;
  minDay: number;
  maxDay: number;
  totalWeight: bigint;
}

interface OrigEntry {
  day: number;
  rev: number;
  weight: bigint;
}

interface Block {
  /** Invoice indices sorted by (dueDay, index). */
  invoiceIdxs: number[];
  /** Parallel arrays aligned with invoiceIdxs for cache-friendly boundary scans. */
  invDays: number[];
  revs: number[];
  origs: bigint[];
  minSeqs: number[];
  maxSeqs: number[];
  minDays: number[];
  maxDays: number[];
  totalWeights: bigint[];
  minDue: number;
  maxDue: number;
  /** Original-amount updates in append (revision) order. */
  origSeq: OrigEntry[];
  origDays: number[];
  origFenwick: FenwickHistory | null;
  origBuilt: number;
  /** All-visible fast path: sorted invoice days with prefix sums, lazy. */
  origAllDays: number[];
  origAllPrefix: bigint[];
  origAllDirty: boolean;
  /** Payment/reversal events in append (sequence) order. */
  evSeq: InvoiceEvent[];
  evDays: number[];
  evFenwick: FenwickHistory | null;
  evBuilt: number;
  /** All-visible fast path: sorted effective days with prefix sums, lazy. */
  evAllDays: number[];
  evAllPrefix: bigint[];
  evAllDirty: boolean;
}

function newBlock(): Block {
  return {
    invoiceIdxs: [],
    invDays: [],
    revs: [],
    origs: [],
    minSeqs: [],
    maxSeqs: [],
    minDays: [],
    maxDays: [],
    totalWeights: [],
    minDue: 0,
    maxDue: 0,
    origSeq: [],
    origDays: [],
    origFenwick: null,
    origBuilt: 0,
    origAllDays: [],
    origAllPrefix: [],
    origAllDirty: true,
    evSeq: [],
    evDays: [],
    evFenwick: null,
    evBuilt: 0,
    evAllDays: [],
    evAllPrefix: [],
    evAllDirty: true,
  };
}

/** Count of elements <= value in a sorted array. */
function upperBound(sorted: number[], value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Internal per-currency index. Invoices of one currency are partitioned into
 * blocks ordered by due date, so that for any report date the five aging
 * buckets map to five contiguous ranges of blocks. Each block aggregates
 * original amounts (keyed by invoice day, filtered by revision) and
 * payment/reversal events (keyed by effective day, filtered by event
 * sequence) into Fenwick trees with per-node history; blocks whose records
 * are all visible at the queried revision use plain sorted-prefix arrays
 * instead. Only boundary blocks of each bucket range are scanned per invoice.
 */
export class CurrencyIndex {
  readonly currency: string;
  private readonly invoices: InvoiceRecord[] = [];
  private readonly blocks: Block[] = [];
  private firstInvoiceRevision = -1;

  constructor(currency: string) {
    this.currency = currency;
  }

  /** Registers a new invoice and returns its per-currency index. */
  addInvoice(orig: bigint, invDay: number, dueDay: number, revision: number): number {
    if (this.firstInvoiceRevision === -1) this.firstInvoiceRevision = revision;
    const invoice: InvoiceRecord = {
      orig,
      invDay,
      dueDay,
      revision,
      block: newBlock(),
      events: [],
      minSeq: 0,
      maxSeq: 0,
      minDay: 0,
      maxDay: 0,
      totalWeight: 0n,
    };
    const idx = this.invoices.length;
    this.invoices.push(invoice);
    this.insertIntoBlocks(idx);
    return idx;
  }

  /** Appends a payment (negative weight) or reversal (positive weight) event. */
  addEvent(invoiceIdx: number, day: number, seq: number, weight: bigint): void {
    const invoice = this.invoices[invoiceIdx];
    const event: InvoiceEvent = { day, seq, weight };
    if (invoice.events.length === 0) {
      invoice.minSeq = seq;
      invoice.maxSeq = seq;
      invoice.minDay = day;
      invoice.maxDay = day;
    } else {
      if (seq < invoice.minSeq) invoice.minSeq = seq;
      if (seq > invoice.maxSeq) invoice.maxSeq = seq;
      if (day < invoice.minDay) invoice.minDay = day;
      if (day > invoice.maxDay) invoice.maxDay = day;
    }
    invoice.totalWeight += weight;
    invoice.events.push(event);
    const block = invoice.block;
    block.evSeq.push(event);
    block.evAllDirty = true;
    // Keep the block-local summary arrays in sync.
    const pos = block.invoiceIdxs.indexOf(invoiceIdx);
    block.minSeqs[pos] = invoice.minSeq;
    block.maxSeqs[pos] = invoice.maxSeq;
    block.minDays[pos] = invoice.minDay;
    block.maxDays[pos] = invoice.maxDay;
    block.totalWeights[pos] = invoice.totalWeight;
  }

  invoiceInvDay(invoiceIdx: number): number {
    return this.invoices[invoiceIdx].invDay;
  }

  /** Whether this currency has at least one invoice visible at the given revision. */
  hasVisibleInvoice(revision: number): boolean {
    return this.firstInvoiceRevision !== -1 && this.firstInvoiceRevision <= revision;
  }

  private insertIntoBlocks(invoiceIdx: number): void {
    const invoice = this.invoices[invoiceIdx];
    if (this.blocks.length === 0) this.blocks.push(newBlock());
    // First block whose maxDue >= invoice.dueDay; blocks partition the due-day axis.
    let lo = 0;
    let hi = this.blocks.length - 1;
    let pos = this.blocks.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (this.blocks[mid].maxDue >= invoice.dueDay) {
        pos = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }
    const block = this.blocks[pos];
    const arr = block.invoiceIdxs;
    let i = arr.length;
    while (i > 0) {
      const other = this.invoices[arr[i - 1]];
      if (
        other.dueDay < invoice.dueDay ||
        (other.dueDay === invoice.dueDay && arr[i - 1] < invoiceIdx)
      ) {
        break;
      }
      i--;
    }
    arr.splice(i, 0, invoiceIdx);
    block.invDays.splice(i, 0, invoice.invDay);
    block.revs.splice(i, 0, invoice.revision);
    block.origs.splice(i, 0, invoice.orig);
    block.minSeqs.splice(i, 0, invoice.minSeq);
    block.maxSeqs.splice(i, 0, invoice.maxSeq);
    block.minDays.splice(i, 0, invoice.minDay);
    block.maxDays.splice(i, 0, invoice.maxDay);
    block.totalWeights.splice(i, 0, invoice.totalWeight);
    block.minDue = this.invoices[arr[0]].dueDay;
    block.maxDue = this.invoices[arr[arr.length - 1]].dueDay;
    invoice.block = block;
    block.origSeq.push({ day: invoice.invDay, rev: invoice.revision, weight: invoice.orig });
    block.origAllDirty = true;
    if (arr.length > MAX_BLOCK_INVOICES) this.splitBlock(pos);
  }

  private splitBlock(pos: number): void {
    const block = this.blocks[pos];
    const half = block.invoiceIdxs.length >> 1;
    const halves = [block.invoiceIdxs.slice(0, half), block.invoiceIdxs.slice(half)];
    const newBlocks: Block[] = [];
    const halfIdx = halves[0].length;
    for (const idxs of halves) {
      const offset = idxs === halves[0] ? 0 : halfIdx;
      const created = newBlock();
      created.invoiceIdxs = idxs;
      created.invDays = block.invDays.slice(offset, offset + idxs.length);
      created.revs = block.revs.slice(offset, offset + idxs.length);
      created.origs = block.origs.slice(offset, offset + idxs.length);
      created.minSeqs = block.minSeqs.slice(offset, offset + idxs.length);
      created.maxSeqs = block.maxSeqs.slice(offset, offset + idxs.length);
      created.minDays = block.minDays.slice(offset, offset + idxs.length);
      created.maxDays = block.maxDays.slice(offset, offset + idxs.length);
      created.totalWeights = block.totalWeights.slice(offset, offset + idxs.length);
      created.minDue = this.invoices[idxs[0]].dueDay;
      created.maxDue = this.invoices[idxs[idxs.length - 1]].dueDay;
      for (const idx of idxs) {
        const invoice = this.invoices[idx];
        invoice.block = created;
        created.origSeq.push({ day: invoice.invDay, rev: invoice.revision, weight: invoice.orig });
        for (const event of invoice.events) created.evSeq.push(event);
      }
      created.origSeq.sort((a, b) => a.rev - b.rev);
      created.evSeq.sort((a, b) => a.seq - b.seq);
      newBlocks.push(created);
    }
    this.blocks.splice(pos, 1, newBlocks[0], newBlocks[1]);
  }

  private ensureOrigBuilt(block: Block): void {
    if (block.origSeq.length - block.origBuilt < TAIL_LIMIT) return;
    const days = [...new Set(block.origSeq.map((e) => e.day))].sort((a, b) => a - b);
    const fenwick = new FenwickHistory(days.length);
    for (const entry of block.origSeq) {
      fenwick.add(upperBound(days, entry.day) - 1, entry.rev, entry.weight);
    }
    block.origDays = days;
    block.origFenwick = fenwick;
    block.origBuilt = block.origSeq.length;
  }

  private ensureEventsBuilt(block: Block): void {
    if (block.evSeq.length - block.evBuilt < TAIL_LIMIT) return;
    const days = [...new Set(block.evSeq.map((e) => e.day))].sort((a, b) => a - b);
    const fenwick = new FenwickHistory(days.length);
    for (const event of block.evSeq) {
      fenwick.add(upperBound(days, event.day) - 1, event.seq, event.weight);
    }
    block.evDays = days;
    block.evFenwick = fenwick;
    block.evBuilt = block.evSeq.length;
  }

  /** Original amounts of the block with invoice day <= reportDay and revision <= revision. */
  private originalsAgg(block: Block, reportDay: number, revision: number): bigint {
    const last = block.origSeq[block.origSeq.length - 1];
    if (last === undefined || revision >= last.rev) {
      // All originals in the block are visible: plain sorted-prefix lookup.
      if (block.origAllDirty) {
        const entries = [...block.origSeq].sort((a, b) => a.day - b.day);
        const days = new Array<number>(entries.length);
        const prefix = new Array<bigint>(entries.length);
        let sum = 0n;
        for (let i = 0; i < entries.length; i++) {
          days[i] = entries[i].day;
          sum += entries[i].weight;
          prefix[i] = sum;
        }
        block.origAllDays = days;
        block.origAllPrefix = prefix;
        block.origAllDirty = false;
      }
      const count = upperBound(block.origAllDays, reportDay);
      return count === 0 ? 0n : block.origAllPrefix[count - 1];
    }
    this.ensureOrigBuilt(block);
    let sum = 0n;
    if (block.origFenwick !== null) {
      const bound = upperBound(block.origDays, reportDay) - 1;
      if (bound >= 0) sum += block.origFenwick.prefixSum(bound, revision);
    }
    for (let i = block.origBuilt; i < block.origSeq.length; i++) {
      const entry = block.origSeq[i];
      if (entry.day <= reportDay && entry.rev <= revision) sum += entry.weight;
    }
    return sum;
  }

  /** Net event weights of the block with effective day <= reportDay and seq <= seqLimit. */
  private eventsAgg(block: Block, reportDay: number, seqLimit: number): bigint {
    const last = block.evSeq[block.evSeq.length - 1];
    if (last === undefined) return 0n;
    if (seqLimit >= last.seq) {
      // All events in the block are visible: plain sorted-prefix lookup.
      if (block.evAllDirty) {
        const entries = [...block.evSeq].sort((a, b) => a.day - b.day);
        const days = new Array<number>(entries.length);
        const prefix = new Array<bigint>(entries.length);
        let sum = 0n;
        for (let i = 0; i < entries.length; i++) {
          days[i] = entries[i].day;
          sum += entries[i].weight;
          prefix[i] = sum;
        }
        block.evAllDays = days;
        block.evAllPrefix = prefix;
        block.evAllDirty = false;
      }
      const count = upperBound(block.evAllDays, reportDay);
      return count === 0 ? 0n : block.evAllPrefix[count - 1];
    }
    this.ensureEventsBuilt(block);
    let sum = 0n;
    if (block.evFenwick !== null) {
      const bound = upperBound(block.evDays, reportDay) - 1;
      if (bound >= 0) sum += block.evFenwick.prefixSum(bound, seqLimit);
    }
    for (let i = block.evBuilt; i < block.evSeq.length; i++) {
      const event = block.evSeq[i];
      if (event.day <= reportDay && event.seq <= seqLimit) sum += event.weight;
    }
    return sum;
  }

  /** Invoice-by-invoice scan restricted to due days inside [lo, hi]. */
  private partialSum(
    block: Block,
    lo: number,
    hi: number,
    reportDay: number,
    revision: number,
    seqLimit: number,
  ): bigint {
    const arr = block.invoiceIdxs;
    // Invoices are sorted by dueDay: binary-search the overlapping slice.
    let start = 0;
    let end = arr.length;
    while (start < end) {
      const mid = (start + end) >>> 1;
      if (this.invoices[arr[mid]].dueDay < lo) start = mid + 1;
      else end = mid;
    }
    const first = start;
    end = arr.length;
    while (start < end) {
      const mid = (start + end) >>> 1;
      if (this.invoices[arr[mid]].dueDay <= hi) start = mid + 1;
      else end = mid;
    }
    const invDays = block.invDays;
    const revs = block.revs;
    const origs = block.origs;
    const minSeqs = block.minSeqs;
    const maxSeqs = block.maxSeqs;
    const minDays = block.minDays;
    const maxDays = block.maxDays;
    const totalWeights = block.totalWeights;
    let sum = 0n;
    for (let i = first; i < start; i++) {
      if (invDays[i] > reportDay || revs[i] > revision) continue;
      // O(1) resolution when no event is visible, or all of them are.
      if (minSeqs[i] === 0 || minSeqs[i] > seqLimit || minDays[i] > reportDay) {
        sum += origs[i];
        continue;
      }
      if (maxSeqs[i] <= seqLimit && maxDays[i] <= reportDay) {
        sum += origs[i] + totalWeights[i];
        continue;
      }
      let balance = origs[i];
      for (const event of this.invoices[arr[i]].events) {
        if (event.day <= reportDay && event.seq <= seqLimit) balance += event.weight;
      }
      sum += balance;
    }
    return sum;
  }

  /**
   * Accumulates this currency's five bucket sums (scaled units) for the given
   * report day into `out` (length 5: current, 1-30, 31-60, 61-90, 90+).
   * Only originals with revision <= `revision` and events with seq <= `seqLimit`
   * are visible.
   */
  accumulate(reportDay: number, revision: number, seqLimit: number, out: bigint[]): void {
    // Bucket due-day ranges: [lo, hi] pairs partitioning the axis.
    const loOf = [
      reportDay,
      reportDay - 30,
      reportDay - 60,
      reportDay - 90,
      Number.MIN_SAFE_INTEGER,
    ];
    const hiOf = [
      Number.MAX_SAFE_INTEGER,
      reportDay - 1,
      reportDay - 31,
      reportDay - 61,
      reportDay - 91,
    ];
    for (const block of this.blocks) {
      const minDue = block.minDue;
      const maxDue = block.maxDue;
      for (let bucket = 0; bucket < 5; bucket++) {
        const lo = loOf[bucket];
        const hi = hiOf[bucket];
        if (maxDue < lo || minDue > hi) continue;
        if (minDue >= lo && maxDue <= hi) {
          out[bucket] +=
            this.originalsAgg(block, reportDay, revision) +
            this.eventsAgg(block, reportDay, seqLimit);
        } else {
          out[bucket] += this.partialSum(block, lo, hi, reportDay, revision, seqLimit);
        }
      }
    }
  }
}
