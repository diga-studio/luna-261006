/** Amount accepted by the public API: a JSON number or a decimal string. */
export type AmountInput = number | string;

/** A new invoice. Invoices are immutable once recorded. */
export interface InvoiceInput {
  /** Unique invoice identifier. */
  invoiceId: string;
  /** ISO 4217-style currency code, used as-is for grouping. */
  currency: string;
  /** Original invoice amount, at most 4 decimal places. */
  amount: AmountInput;
  /** Invoice (business) date, "YYYY-MM-DD", years 2000..2099. */
  invoiceDate: string;
  /** Due date, "YYYY-MM-DD", years 2000..2099. */
  dueDate: string;
}

/** A payment/write-off that reduces the open balance of an invoice. */
export interface PaymentInput {
  invoiceId: string;
  amount: AmountInput;
  /** Business date on which the payment applies, "YYYY-MM-DD". */
  businessDate: string;
}

/** A reversal of a previous payment; restores the open balance from its own business date. */
export interface ReversalInput {
  invoiceId: string;
  amount: AmountInput;
  /** Business date from which the reversal restores the balance, "YYYY-MM-DD". */
  businessDate: string;
}

/**
 * An append-only batch. All records in a batch take effect together and the
 * batch receives the next consecutive revision number.
 */
export interface Batch {
  invoices?: InvoiceInput[];
  payments?: PaymentInput[];
  reversals?: ReversalInput[];
}

/** The five aging buckets, amounts rendered as exact decimal strings. */
export interface BucketAmounts {
  /** Not yet due, or due on the report date itself. */
  current: string;
  /** 1..30 days past due. */
  days1To30: string;
  /** 31..60 days past due. */
  days31To60: string;
  /** 61..90 days past due. */
  days61To90: string;
  /** More than 90 days past due. */
  over90: string;
}

/** Aging report: one entry per visible currency, keyed by currency code. */
export type AgingReport = Record<string, BucketAmounts>;
