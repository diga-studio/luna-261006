/**
 * Public API types for the accounts payable aging ledger.
 *
 * Dates are ISO calendar day strings "YYYY-MM-DD" in the range 2000..2099.
 * Amounts are decimal values with at most 4 fractional digits; they may be
 * passed as number or string (string is recommended for exactness) and are
 * always returned as canonical decimal strings.
 */

export interface InvoiceInput {
  /** Unique invoice identifier. */
  id: string;
  /** Currency code, e.g. "USD". */
  currency: string;
  /** Original invoice amount, up to 4 decimal places. */
  amount: number | string;
  /** Invoice (billing) date, "YYYY-MM-DD". */
  invoiceDate: string;
  /** Due date, "YYYY-MM-DD". */
  dueDate: string;
}

export interface PaymentInput {
  /** Invoice this payment applies to. */
  invoiceId: string;
  /** Paid amount in the invoice currency, up to 4 decimal places. */
  amount: number | string;
  /** Business date of the payment, "YYYY-MM-DD". */
  date: string;
}

export interface ReversalInput {
  /** Invoice whose payment is reversed. */
  invoiceId: string;
  /** Reversed amount in the invoice currency, up to 4 decimal places. */
  amount: number | string;
  /** Business date from which the balance is restored, "YYYY-MM-DD". */
  date: string;
}

export interface Batch {
  invoices?: InvoiceInput[];
  payments?: PaymentInput[];
  reversals?: ReversalInput[];
}

/** Aging bucket balances for one currency. All values are decimal strings. */
export interface BucketAmounts {
  /** Not yet due (due date on or after the report date). */
  current: string;
  /** Overdue by 1..30 days. */
  overdue1To30: string;
  /** Overdue by 31..60 days. */
  overdue31To60: string;
  /** Overdue by 61..90 days. */
  overdue61To90: string;
  /** Overdue by more than 90 days. */
  overdue90Plus: string;
}

export interface AgingReport {
  /** Report business date as passed to the query. */
  reportDate: string;
  /** Visible revision as passed to the query (clamped to existing revisions). */
  revision: number;
  /** Per-currency five-bucket balances, keyed by currency code. */
  currencies: Record<string, BucketAmounts>;
}
