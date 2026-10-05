import { CurrencyIndex } from "./currencyIndex.ts";
import { parseDate } from "./date.ts";
import { formatAmount, parseAmount } from "./money.ts";
import type {
  AgingReport,
  Batch,
  PaymentInput,
  ReversalInput,
} from "./types.ts";

interface InvoiceTarget {
  index: CurrencyIndex;
  invoiceIdx: number;
}

/**
 * Append-only in-memory accounts-payable aging ledger.
 *
 * - `appendBatch` applies a whole batch atomically and returns its revision
 *   number (1, 2, 3, ...).
 * - `queryAging` reports five-bucket balances per currency as of a report
 *   business date, seeing only records from revisions <= maxRevision.
 *   The same (reportDate, maxRevision) pair always yields the same result,
 *   regardless of batches appended afterwards.
 */
export class AgingLedger {
  private readonly currencies = new Map<string, CurrencyIndex>();
  private readonly invoiceRegistry = new Map<string, InvoiceTarget>();
  private revision = 0;
  private eventCount = 0;
  /** revisionEventCount[r] = total payment/reversal events in batches 1..r. */
  private readonly revisionEventCount: number[] = [0];

  /** Number of batches appended so far; also the latest revision number. */
  get currentRevision(): number {
    return this.revision;
  }

  /** Appends a batch and returns its new revision number. */
  appendBatch(batch: Batch): number {
    this.revision++;
    for (const invoice of batch.invoices ?? []) {
      if (this.invoiceRegistry.has(invoice.invoiceId)) {
        throw new Error(`Duplicate invoice id: ${invoice.invoiceId}`);
      }
      const orig = parseAmount(invoice.amount);
      const invDay = parseDate(invoice.invoiceDate);
      const dueDay = parseDate(invoice.dueDate);
      let index = this.currencies.get(invoice.currency);
      if (index === undefined) {
        index = new CurrencyIndex(invoice.currency);
        this.currencies.set(invoice.currency, index);
      }
      const invoiceIdx = index.addInvoice(orig, invDay, dueDay, this.revision);
      this.invoiceRegistry.set(invoice.invoiceId, { index, invoiceIdx });
    }
    for (const payment of batch.payments ?? []) this.addEvent(payment, -1n);
    for (const reversal of batch.reversals ?? []) this.addEvent(reversal, 1n);
    this.revisionEventCount.push(this.eventCount);
    return this.revision;
  }

  private addEvent(record: PaymentInput | ReversalInput, sign: bigint): void {
    const target = this.invoiceRegistry.get(record.invoiceId);
    if (target === undefined) {
      throw new Error(`Unknown invoice id: ${record.invoiceId}`);
    }
    const amount = parseAmount(record.amount);
    const day = parseDate(record.businessDate);
    // Redate to the invoice day if earlier: an invoice that is not yet billed
    // on the report date contributes nothing, and for billed invoices this
    // keeps the day filter equivalent to the raw business date.
    const effectiveDay = Math.max(day, target.index.invoiceInvDay(target.invoiceIdx));
    this.eventCount++;
    target.index.addEvent(target.invoiceIdx, effectiveDay, this.eventCount, sign * amount);
  }

  /**
   * Aging summary for a report business date, using only records visible at
   * `maxRevision` (defaults to the latest revision). Returns one entry per
   * visible currency; amounts are exact decimal strings.
   */
  queryAging(reportDate: string, maxRevision?: number): AgingReport {
    const reportDay = parseDate(reportDate);
    const revision = maxRevision ?? this.revision;
    if (!Number.isInteger(revision) || revision < 0 || revision > this.revision) {
      throw new Error(`Invalid revision ${maxRevision}; current revision is ${this.revision}`);
    }
    const seqLimit = this.revisionEventCount[revision];
    const out = [0n, 0n, 0n, 0n, 0n];
    const report: AgingReport = {};
    for (const [currency, index] of this.currencies) {
      if (!index.hasVisibleInvoice(revision)) continue;
      out.fill(0n);
      index.accumulate(reportDay, revision, seqLimit, out);
      report[currency] = {
        current: formatAmount(out[0]),
        days1To30: formatAmount(out[1]),
        days31To60: formatAmount(out[2]),
        days61To90: formatAmount(out[3]),
        over90: formatAmount(out[4]),
      };
    }
    return report;
  }
}
