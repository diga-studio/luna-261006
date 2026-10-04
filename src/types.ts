/** PO 行约定：不可变，单价为整数美分，仅支持 USD。 */
export interface PoLineSpec {
  poLineId: string;
  unitPriceCents: number;
}

/** 发票行：数量为正整数，金额为整数美分。 */
export interface InvoiceLine {
  poLineId: string;
  quantity: number;
  amountCents: number;
}

/** 同一 PO 行合并后的价差报告条目。 */
export interface ReviewReportLine {
  poLineId: string;
  quantity: number;
  expectedCents: number;
  actualCents: number;
  diffCents: number;
  thresholdCents: number;
  flagged: boolean;
}

/** 触发人工复核时传给 review 的报告。 */
export interface ReviewReport {
  invoiceId: string;
  lines: ReviewReportLine[];
}

export type ReviewFn = (report: ReviewReport) => Promise<boolean>;

export type ReconcileResult =
  | { status: 'authorized' }
  | { status: 'rejected' }
  | { status: 'failed'; reason: string };

export type InvoiceStatus =
  | 'pending-review'
  | 'authorized'
  | 'rejected'
  | 'invalidated'
  | 'failed';

/** 某张发票在某条验收记录上的占用。 */
export interface Allocation {
  receiptId: string;
  quantity: number;
}

export interface ReceiptSnapshot {
  receiptId: string;
  poLineId: string;
  approvedQty: number;
  authorizedQty: number;
  heldQty: number;
  availableQty: number;
}

export interface InvoiceSnapshot {
  invoiceId: string;
  status: InvoiceStatus;
  lines: InvoiceLine[];
  allocations: Allocation[];
}

export interface Snapshot {
  receipts: ReceiptSnapshot[];
  invoices: InvoiceSnapshot[];
}
