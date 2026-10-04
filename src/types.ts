/** Immutable purchase-order line agreed at initialization. */
export interface PoLine {
  readonly poLineId: string;
  readonly unitPriceCents: number;
}

/** One invoice line submitted for reconciliation. */
export interface InvoiceLine {
  readonly poLineId: string;
  readonly quantity: number;
  readonly amountCents: number;
}

/**
 * Review callback. Called at most once per reconcile attempt, only when a
 * price variance requires manual review. Resolves truthy to approve,
 * falsy (or throws) to reject.
 */
export type ReviewFn = (report: ReviewReport) => Promise<boolean>;

export interface VarianceLine {
  readonly poLineId: string;
  readonly mergedQuantity: number;
  readonly expectedCents: number;
  readonly actualCents: number;
  readonly diffCents: number;
}

export interface ReviewReport {
  readonly invoiceId: string;
  readonly variances: readonly VarianceLine[];
}

export type InvoiceStatus =
  | "authorized"
  | "pending_review"
  | "rejected"
  | "invalidated";

/** How a receipt's approved quantity is currently consumed. */
export interface ReceiptAllocation {
  readonly invoiceId: string;
  readonly quantity: number;
  readonly kind: "authorized" | "reserved";
}

export interface ReceiptSnapshot {
  readonly receiptId: string;
  readonly poLineId: string;
  readonly approvedQty: number;
  readonly authorizedQty: number;
  readonly reservedQty: number;
  readonly availableQty: number;
  readonly allocations: readonly ReceiptAllocation[];
}

export interface InvoiceSnapshot {
  readonly invoiceId: string;
  readonly status: InvoiceStatus;
  readonly lines: readonly InvoiceLine[];
}

export interface ReconciliationSnapshot {
  readonly receipts: readonly ReceiptSnapshot[];
  readonly invoices: readonly InvoiceSnapshot[];
}
