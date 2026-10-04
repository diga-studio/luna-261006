import {
  Allocation,
  InvoiceLine,
  InvoiceStatus,
  PoLineSpec,
  ReconcileResult,
  ReviewFn,
  ReviewReportLine,
  Snapshot,
} from './types';

const ABS_TOLERANCE_CENTS = 5000;

interface ReceiptState {
  receiptId: string;
  poLineId: string;
  approvedQty: number;
  authorizedQty: number;
  /** invoiceId -> 预占数量 */
  holds: Map<string, number>;
}

interface InvoiceState {
  invoiceId: string;
  /** 首次对账时固定的内容（规范化排序后），用于校验同一 invoiceId 内容不变 */
  canonicalLines: string;
  lines: InvoiceLine[];
  status: InvoiceStatus;
  /** receiptId -> 占用数量（预占或已授权） */
  allocations: Map<string, number>;
  /** 对账尝试开始顺序号，单调递增 */
  seq: number;
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function canonicalizeLines(lines: InvoiceLine[]): string {
  return JSON.stringify(
    [...lines].sort((a, b) =>
      a.poLineId === b.poLineId
        ? a.quantity - b.quantity || a.amountCents - b.amountCents
        : a.poLineId < b.poLineId
          ? -1
          : 1,
    ),
  );
}

export class Reconciler {
  private readonly unitPriceByPoLine = new Map<string, number>();
  /** Map 迭代顺序即验收记录首次创建顺序 */
  private readonly receipts = new Map<string, ReceiptState>();
  private readonly invoices = new Map<string, InvoiceState>();
  private attemptSeq = 0;

  constructor(poLines: PoLineSpec[]) {
    if (!Array.isArray(poLines) || poLines.length === 0) {
      throw new Error('poLines must be a non-empty array');
    }
    for (const line of poLines) {
      if (!line || typeof line.poLineId !== 'string' || line.poLineId === '') {
        throw new Error('poLineId must be a non-empty string');
      }
      if (!isNonNegativeInteger(line.unitPriceCents)) {
        throw new Error(`unitPriceCents for ${line.poLineId} must be a non-negative integer`);
      }
      if (this.unitPriceByPoLine.has(line.poLineId)) {
        throw new Error(`duplicate poLineId: ${line.poLineId}`);
      }
      this.unitPriceByPoLine.set(line.poLineId, line.unitPriceCents);
    }
  }

  setReceipt(receiptId: string, poLineId: string, approvedQty: number): void {
    if (typeof receiptId !== 'string' || receiptId === '') {
      throw new Error('receiptId must be a non-empty string');
    }
    if (!this.unitPriceByPoLine.has(poLineId)) {
      throw new Error(`unknown poLineId: ${poLineId}`);
    }
    if (!isNonNegativeInteger(approvedQty)) {
      throw new Error('approvedQty must be a non-negative integer');
    }

    const existing = this.receipts.get(receiptId);
    if (!existing) {
      this.receipts.set(receiptId, {
        receiptId,
        poLineId,
        approvedQty,
        authorizedQty: 0,
        holds: new Map(),
      });
      return;
    }
    if (existing.poLineId !== poLineId) {
      throw new Error(`receipt ${receiptId} already belongs to ${existing.poLineId}`);
    }
    if (approvedQty < existing.authorizedQty) {
      throw new Error(
        `approvedQty ${approvedQty} is below authorized qty ${existing.authorizedQty} on ${receiptId}`,
      );
    }

    existing.approvedQty = approvedQty;
    // 若现有占用仍超额，按对账尝试开始顺序从新到旧，使占用该记录的待复核发票整单失效
    for (;;) {
      const overBy = this.usedQty(existing) - existing.approvedQty;
      if (overBy <= 0) {
        break;
      }
      const victim = this.newestPendingInvoiceHolding(receiptId);
      if (!victim) {
        break;
      }
      this.invalidateInvoice(victim);
    }
  }

  async reconcile(
    invoiceId: string,
    lines: InvoiceLine[],
    review: ReviewFn,
  ): Promise<ReconcileResult> {
    if (typeof invoiceId !== 'string' || invoiceId === '') {
      throw new Error('invoiceId must be a non-empty string');
    }
    if (typeof review !== 'function') {
      throw new Error('review must be a function');
    }
    if (!Array.isArray(lines) || lines.length === 0) {
      throw new Error('lines must be a non-empty array');
    }
    for (const line of lines) {
      if (!this.unitPriceByPoLine.has(line.poLineId)) {
        throw new Error(`unknown poLineId: ${line.poLineId}`);
      }
      if (!isPositiveInteger(line.quantity)) {
        throw new Error('line quantity must be a positive integer');
      }
      if (!isNonNegativeInteger(line.amountCents)) {
        throw new Error('line amountCents must be a non-negative integer');
      }
    }

    const canonical = canonicalizeLines(lines);
    const attempt = ++this.attemptSeq;
    let invoice = this.invoices.get(invoiceId);
    if (invoice) {
      if (invoice.canonicalLines !== canonical) {
        throw new Error(`invoice ${invoiceId} content is immutable`);
      }
      if (invoice.status === 'authorized') {
        // 已授权发票不得重复占用或重复授权
        return { status: 'authorized' };
      }
      if (invoice.status === 'pending-review') {
        throw new Error(`invoice ${invoiceId} is already under review`);
      }
      // rejected / invalidated / failed：允许重试
      invoice.allocations.clear();
      invoice.seq = attempt;
    } else {
      invoice = {
        invoiceId,
        canonicalLines: canonical,
        lines: lines.map((l) => ({ ...l })),
        status: 'failed',
        allocations: new Map(),
        seq: attempt,
      };
      this.invoices.set(invoiceId, invoice);
    }

    // 同一 PO 行合并：数量与金额分别汇总
    const merged = new Map<string, { quantity: number; amountCents: number }>();
    for (const line of lines) {
      const bucket = merged.get(line.poLineId) ?? { quantity: 0, amountCents: 0 };
      bucket.quantity += line.quantity;
      bucket.amountCents += line.amountCents;
      merged.set(line.poLineId, bucket);
    }

    // 数量不足则整单失败，不调用 review；占用全部完成前不产生任何可见副作用之外的中间态
    const staged: Array<{ receipt: ReceiptState; quantity: number }> = [];
    for (const [poLineId, bucket] of merged) {
      let remaining = bucket.quantity;
      for (const receipt of this.receipts.values()) {
        if (receipt.poLineId !== poLineId) {
          continue;
        }
        const available = receipt.approvedQty - this.usedQty(receipt);
        if (available <= 0) {
          continue;
        }
        const take = Math.min(available, remaining);
        staged.push({ receipt, quantity: take });
        remaining -= take;
        if (remaining === 0) {
          break;
        }
      }
      if (remaining > 0) {
        invoice.status = 'failed';
        return { status: 'failed', reason: `insufficient approved quantity on ${poLineId}` };
      }
    }
    for (const { receipt, quantity } of staged) {
      receipt.holds.set(invoiceId, (receipt.holds.get(invoiceId) ?? 0) + quantity);
      invoice.allocations.set(
        receipt.receiptId,
        (invoice.allocations.get(receipt.receiptId) ?? 0) + quantity,
      );
    }

    // 价差判断：绝对差严格大于 max(5000, 期望的5%) 才复核；用整数运算避免浮点误差
    const reportLines: ReviewReportLine[] = [];
    let anyFlagged = false;
    for (const [poLineId, bucket] of merged) {
      const unitPrice = this.unitPriceByPoLine.get(poLineId)!;
      const expectedCents = bucket.quantity * unitPrice;
      const diffCents = Math.abs(bucket.amountCents - expectedCents);
      const flagged =
        diffCents * 100 > Math.max(ABS_TOLERANCE_CENTS * 100, expectedCents * 5);
      if (flagged) {
        anyFlagged = true;
      }
      reportLines.push({
        poLineId,
        quantity: bucket.quantity,
        expectedCents,
        actualCents: bucket.amountCents,
        diffCents,
        thresholdCents: Math.max(ABS_TOLERANCE_CENTS, expectedCents * 0.05),
        flagged,
      });
    }

    if (!anyFlagged) {
      this.authorize(invoice);
      return { status: 'authorized' };
    }

    invoice.status = 'pending-review';
    let approved: boolean;
    try {
      approved = await review({ invoiceId, lines: reportLines });
    } catch {
      approved = false;
    }
    if (invoice.status !== 'pending-review') {
      // review 期间该发票已被验收更正失效，占用已释放
      return { status: 'failed', reason: `invoice ${invoiceId} was invalidated during review` };
    }
    if (approved) {
      this.authorize(invoice);
      return { status: 'authorized' };
    }
    this.release(invoice);
    invoice.status = 'rejected';
    return { status: 'rejected' };
  }

  snapshot(): Snapshot {
    return {
      receipts: [...this.receipts.values()].map((receipt) => {
        const heldQty = this.heldQty(receipt);
        return {
          receiptId: receipt.receiptId,
          poLineId: receipt.poLineId,
          approvedQty: receipt.approvedQty,
          authorizedQty: receipt.authorizedQty,
          heldQty,
          availableQty: receipt.approvedQty - receipt.authorizedQty - heldQty,
        };
      }),
      invoices: [...this.invoices.values()].map((invoice) => ({
        invoiceId: invoice.invoiceId,
        status: invoice.status,
        lines: invoice.lines.map((l) => ({ ...l })),
        allocations: [...invoice.allocations.entries()].map(
          ([receiptId, quantity]): Allocation => ({ receiptId, quantity }),
        ),
      })),
    };
  }

  private usedQty(receipt: ReceiptState): number {
    return receipt.authorizedQty + this.heldQty(receipt);
  }

  private heldQty(receipt: ReceiptState): number {
    let total = 0;
    for (const qty of receipt.holds.values()) {
      total += qty;
    }
    return total;
  }

  private newestPendingInvoiceHolding(receiptId: string): InvoiceState | undefined {
    let newest: InvoiceState | undefined;
    for (const invoice of this.invoices.values()) {
      if (invoice.status !== 'pending-review') {
        continue;
      }
      if (!invoice.allocations.has(receiptId)) {
        continue;
      }
      if (!newest || invoice.seq > newest.seq) {
        newest = invoice;
      }
    }
    return newest;
  }

  /** 整单失效：释放该发票在所有验收记录上的预占。 */
  private invalidateInvoice(invoice: InvoiceState): void {
    this.release(invoice);
    invoice.status = 'invalidated';
  }

  private release(invoice: InvoiceState): void {
    for (const [receiptId, quantity] of invoice.allocations) {
      const receipt = this.receipts.get(receiptId);
      if (receipt) {
        const held = receipt.holds.get(invoice.invoiceId) ?? 0;
        const remaining = held - quantity;
        if (remaining > 0) {
          receipt.holds.set(invoice.invoiceId, remaining);
        } else {
          receipt.holds.delete(invoice.invoiceId);
        }
      }
    }
    invoice.allocations.clear();
  }

  private authorize(invoice: InvoiceState): void {
    for (const [receiptId, quantity] of invoice.allocations) {
      const receipt = this.receipts.get(receiptId);
      if (!receipt) {
        continue;
      }
      receipt.holds.delete(invoice.invoiceId);
      receipt.authorizedQty += quantity;
    }
    invoice.status = 'authorized';
  }
}
