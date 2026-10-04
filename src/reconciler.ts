import {
  InvoiceLine,
  InvoiceSnapshot,
  InvoiceStatus,
  PoLine,
  ReceiptAllocation,
  ReceiptSnapshot,
  ReconciliationSnapshot,
  ReviewFn,
  ReviewReport,
  VarianceLine,
} from "./types";

interface Allocation {
  invoiceId: string;
  qty: number;
  kind: "authorized" | "reserved";
}

interface ReceiptState {
  readonly receiptId: string;
  readonly poLineId: string;
  approvedQty: number;
  readonly allocations: Allocation[];
}

interface InvoiceState {
  readonly invoiceId: string;
  readonly lines: readonly InvoiceLine[];
  status: InvoiceStatus;
  reason: string | undefined;
  attemptSeq: number;
}

const ABSOLUTE_TOLERANCE_CENTS = 5000;
const RELATIVE_TOLERANCE = 0.05;

function isNonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function sumKind(receipt: ReceiptState, kind: Allocation["kind"]): number {
  let total = 0;
  for (const alloc of receipt.allocations) {
    if (alloc.kind === kind) total += alloc.qty;
  }
  return total;
}

function linesEqual(
  a: readonly InvoiceLine[],
  b: readonly InvoiceLine[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i]!;
    const right = b[i]!;
    if (
      left.poLineId !== right.poLineId ||
      left.quantity !== right.quantity ||
      left.amountCents !== right.amountCents
    ) {
      return false;
    }
  }
  return true;
}

export class Reconciler {
  private readonly unitPrices = new Map<string, number>();
  private readonly receipts = new Map<string, ReceiptState>();
  private readonly invoices = new Map<string, InvoiceState>();
  private attemptCounter = 0;

  constructor(poLines: readonly PoLine[]) {
    for (const line of poLines) {
      if (this.unitPrices.has(line.poLineId)) {
        throw new Error(`duplicate PO line: ${line.poLineId}`);
      }
      if (!isNonNegativeInteger(line.unitPriceCents)) {
        throw new Error(
          `unit price for ${line.poLineId} must be a non-negative integer (USD cents)`,
        );
      }
      this.unitPrices.set(line.poLineId, line.unitPriceCents);
    }
  }

  setReceipt(receiptId: string, poLineId: string, approvedQty: number): void {
    if (!isNonNegativeInteger(approvedQty)) {
      throw new Error("approvedQty must be a non-negative integer");
    }
    const existing = this.receipts.get(receiptId);
    if (!existing) {
      if (!this.unitPrices.has(poLineId)) {
        throw new Error(`unknown PO line: ${poLineId}`);
      }
      this.receipts.set(receiptId, {
        receiptId,
        poLineId,
        approvedQty,
        allocations: [],
      });
      return;
    }
    if (existing.poLineId !== poLineId) {
      throw new Error(
        `receipt ${receiptId} belongs to PO line ${existing.poLineId}, cannot reassign to ${poLineId}`,
      );
    }
    const authorized = sumKind(existing, "authorized");
    if (approvedQty < authorized) {
      throw new Error(
        `approvedQty ${approvedQty} is below authorized quantity ${authorized} on receipt ${receiptId}`,
      );
    }
    existing.approvedQty = approvedQty;
    // Invalidate newest pending invoices first while still over-allocated.
    for (;;) {
      const used = authorized + sumKind(existing, "reserved");
      if (used <= approvedQty) break;
      const victim = this.newestPendingInvoiceOn(receiptId);
      if (!victim) break;
      this.invalidate(victim, "receipt_corrected");
    }
  }

  async reconcile(
    invoiceId: string,
    lines: readonly InvoiceLine[],
    review: ReviewFn,
  ): Promise<InvoiceStatus> {
    this.validateLines(lines);
    let invoice = this.invoices.get(invoiceId);
    if (invoice) {
      if (!linesEqual(invoice.lines, lines)) {
        throw new Error(`invoice ${invoiceId} content is immutable`);
      }
      if (invoice.status === "authorized") {
        throw new Error(`invoice ${invoiceId} is already authorized`);
      }
      if (invoice.status === "pending_review") {
        throw new Error(`invoice ${invoiceId} reconciliation already in flight`);
      }
    } else {
      invoice = {
        invoiceId,
        lines: lines.map((line) => ({ ...line })),
        status: "rejected",
        reason: undefined,
        attemptSeq: 0,
      };
      this.invoices.set(invoiceId, invoice);
    }

    const seq = ++this.attemptCounter;
    const merged = this.mergeLines(lines);
    const plan = this.planAllocations(merged);
    if (!plan) {
      invoice.status = "rejected";
      invoice.reason = "insufficient_quantity";
      return invoice.status;
    }

    const variances = this.findVariances(merged);
    if (variances.length === 0) {
      this.applyPlan(invoiceId, plan, "authorized");
      invoice.status = "authorized";
      invoice.reason = undefined;
      invoice.attemptSeq = seq;
      return invoice.status;
    }

    this.applyPlan(invoiceId, plan, "reserved");
    invoice.status = "pending_review";
    invoice.reason = undefined;
    invoice.attemptSeq = seq;

    const report: ReviewReport = { invoiceId, variances };
    let approved: boolean;
    try {
      approved = await review(report);
    } catch {
      approved = false;
    }

    if (invoice.status !== "pending_review" || invoice.attemptSeq !== seq) {
      // Invalidated by a receipt correction while review was in flight.
      return invoice.status;
    }
    if (approved) {
      this.convertReservations(invoiceId);
      invoice.status = "authorized";
    } else {
      this.releaseReservations(invoiceId);
      invoice.status = "rejected";
      invoice.reason = "review_rejected";
    }
    return invoice.status;
  }

  snapshot(): ReconciliationSnapshot {
    const receipts: ReceiptSnapshot[] = [];
    for (const receipt of this.receipts.values()) {
      const authorizedQty = sumKind(receipt, "authorized");
      const reservedQty = sumKind(receipt, "reserved");
      const allocations: ReceiptAllocation[] = receipt.allocations.map(
        (alloc) => ({
          invoiceId: alloc.invoiceId,
          quantity: alloc.qty,
          kind: alloc.kind,
        }),
      );
      receipts.push({
        receiptId: receipt.receiptId,
        poLineId: receipt.poLineId,
        approvedQty: receipt.approvedQty,
        authorizedQty,
        reservedQty,
        availableQty: receipt.approvedQty - authorizedQty - reservedQty,
        allocations,
      });
    }
    const invoices: InvoiceSnapshot[] = [];
    for (const invoice of this.invoices.values()) {
      invoices.push({
        invoiceId: invoice.invoiceId,
        status: invoice.status,
        lines: invoice.lines.map((line) => ({ ...line })),
      });
    }
    return { receipts, invoices };
  }

  private validateLines(lines: readonly InvoiceLine[]): void {
    if (lines.length === 0) {
      throw new Error("invoice must contain at least one line");
    }
    for (const line of lines) {
      if (!this.unitPrices.has(line.poLineId)) {
        throw new Error(`unknown PO line: ${line.poLineId}`);
      }
      if (!isPositiveInteger(line.quantity)) {
        throw new Error("invoice line quantity must be a positive integer");
      }
      if (!isNonNegativeInteger(line.amountCents)) {
        throw new Error(
          "invoice line amountCents must be a non-negative integer (USD cents)",
        );
      }
    }
  }

  private mergeLines(
    lines: readonly InvoiceLine[],
  ): Map<string, { quantity: number; amountCents: number }> {
    const merged = new Map<string, { quantity: number; amountCents: number }>();
    for (const line of lines) {
      const entry = merged.get(line.poLineId) ?? { quantity: 0, amountCents: 0 };
      entry.quantity += line.quantity;
      entry.amountCents += line.amountCents;
      merged.set(line.poLineId, entry);
    }
    return merged;
  }

  private planAllocations(
    merged: Map<string, { quantity: number; amountCents: number }>,
  ): { receipt: ReceiptState; qty: number }[] | null {
    const plan: { receipt: ReceiptState; qty: number }[] = [];
    for (const [poLineId, { quantity }] of merged) {
      let needed = quantity;
      for (const receipt of this.receipts.values()) {
        if (receipt.poLineId !== poLineId || needed === 0) continue;
        const available =
          receipt.approvedQty -
          sumKind(receipt, "authorized") -
          sumKind(receipt, "reserved");
        if (available <= 0) continue;
        const take = Math.min(available, needed);
        plan.push({ receipt, qty: take });
        needed -= take;
      }
      if (needed > 0) return null;
    }
    return plan;
  }

  private findVariances(
    merged: Map<string, { quantity: number; amountCents: number }>,
  ): VarianceLine[] {
    const variances: VarianceLine[] = [];
    for (const [poLineId, { quantity, amountCents }] of merged) {
      const expectedCents = quantity * this.unitPrices.get(poLineId)!;
      const diffCents = Math.abs(amountCents - expectedCents);
      const threshold = Math.max(
        ABSOLUTE_TOLERANCE_CENTS,
        expectedCents * RELATIVE_TOLERANCE,
      );
      if (diffCents > threshold) {
        variances.push({
          poLineId,
          mergedQuantity: quantity,
          expectedCents,
          actualCents: amountCents,
          diffCents,
        });
      }
    }
    return variances;
  }

  private applyPlan(
    invoiceId: string,
    plan: { receipt: ReceiptState; qty: number }[],
    kind: Allocation["kind"],
  ): void {
    for (const { receipt, qty } of plan) {
      receipt.allocations.push({ invoiceId, qty, kind });
    }
  }

  private convertReservations(invoiceId: string): void {
    for (const receipt of this.receipts.values()) {
      for (const alloc of receipt.allocations) {
        if (alloc.invoiceId === invoiceId && alloc.kind === "reserved") {
          alloc.kind = "authorized";
        }
      }
    }
  }

  private releaseReservations(invoiceId: string): void {
    for (const receipt of this.receipts.values()) {
      for (let i = receipt.allocations.length - 1; i >= 0; i -= 1) {
        const alloc = receipt.allocations[i]!;
        if (alloc.invoiceId === invoiceId && alloc.kind === "reserved") {
          receipt.allocations.splice(i, 1);
        }
      }
    }
  }

  private newestPendingInvoiceOn(receiptId: string): InvoiceState | null {
    let best: InvoiceState | null = null;
    for (const invoice of this.invoices.values()) {
      if (invoice.status !== "pending_review") continue;
      const holds = [...this.receipts.values()].some(
        (receipt) =>
          receipt.receiptId === receiptId &&
          receipt.allocations.some(
            (alloc) =>
              alloc.invoiceId === invoice.invoiceId && alloc.kind === "reserved",
          ),
      );
      if (!holds) continue;
      if (!best || invoice.attemptSeq > best.attemptSeq) best = invoice;
    }
    return best;
  }

  private invalidate(invoice: InvoiceState, reason: string): void {
    this.releaseReservations(invoice.invoiceId);
    invoice.status = "invalidated";
    invoice.reason = reason;
  }
}
