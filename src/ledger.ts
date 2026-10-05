import { DatabaseSync } from 'node:sqlite';
import { parseDate, formatDate } from './dateutil';
import { emitItemEvents } from './schedule';
import { DailyResult, PrepaidItem, RangeReport, Refund } from './types';

const MAX_AMOUNT = 10n ** 18n;
const MAX_SERVICE_DAYS = 3650;

interface RefundPoint {
  day: number;
  amount: bigint;
}

interface ItemState {
  amount: bigint;
  startDay: number;
  endDay: number;
  /** Sorted by day, not pre-summed. */
  refunds: RefundPoint[];
  refundedTotal: bigint;
}

/**
 * Prepaid subscription revenue closing ledger.
 *
 * Business events (items, refunds) and closed daily results are persisted
 * in SQLite. The close frontier only moves forward; closed daily rows are
 * immutable. Daily results are a pure function of the business facts, so
 * refund entry order, batching and close segmentation never change them.
 *
 * Internally every item contributes O(refunds) dated delta events into
 * four global day-indexed maps (see schedule.ts). Closing sweeps those
 * maps day by day; exporting reads the stored daily rows.
 */
export class RevenueLedger {
  private db: DatabaseSync;
  private items: Map<string, ItemState> = new Map();

  private rateDiff: Map<number, bigint> = new Map();
  private pointAdj: Map<number, bigint> = new Map();
  private prepaidDiff: Map<number, bigint> = new Map();
  private refundDiff: Map<number, bigint> = new Map();

  private frontier: number | null = null;
  private minEventDay: number | null = null;

  // Sweep accumulators, valid for all days <= frontier.
  private accRate = 0n;
  private accRecognized = 0n;
  private accPrepaid = 0n;
  private accRefunded = 0n;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = OFF');
    this.db.exec('PRAGMA synchronous = OFF');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta(
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS items(
        id TEXT PRIMARY KEY,
        amount TEXT NOT NULL,
        start_day INTEGER NOT NULL,
        end_day INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS refunds(
        item_id TEXT NOT NULL,
        day INTEGER NOT NULL,
        amount TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_refunds_item ON refunds(item_id);
      CREATE TABLE IF NOT EXISTS daily(
        day INTEGER PRIMARY KEY,
        revenue TEXT NOT NULL,
        deferred TEXT NOT NULL
      );
    `);
    this.rebuild();
  }

  /** Batch-ingest prepaid items. */
  ingestItems(items: ReadonlyArray<PrepaidItem>): void {
    if (items.length === 0) return;
    const stmt = this.db.prepare('INSERT INTO items(id, amount, start_day, end_day) VALUES (?, ?, ?, ?)');
    this.db.exec('BEGIN');
    try {
      for (const item of items) {
        const state = this.validateItem(item);
        stmt.run(item.id, item.amount.toString(), state.startDay, state.endDay);
        this.items.set(item.id, state);
        this.applyItemEvents(state, 1n);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** Batch-ingest refunds (any effective-date order, may be registered ahead of time). */
  ingestRefunds(refunds: ReadonlyArray<Refund>): void {
    if (refunds.length === 0) return;
    const stmt = this.db.prepare('INSERT INTO refunds(item_id, day, amount) VALUES (?, ?, ?)');
    this.db.exec('BEGIN');
    try {
      for (const refund of refunds) {
        const item = this.validateRefund(refund);
        stmt.run(refund.itemId, parseDate(refund.date), refund.amount.toString());
        this.applyItemEvents(item, -1n);
        this.insertRefundPoint(item, { day: parseDate(refund.date), amount: refund.amount });
        item.refundedTotal += refund.amount;
        this.applyItemEvents(item, 1n);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** Advance the close frontier through the given date (inclusive). */
  closeTo(date: string): void {
    const day = parseDate(date);
    if (this.frontier !== null && day < this.frontier) {
      throw new Error(`close frontier cannot move backwards: ${date} before ${formatDate(this.frontier)}`);
    }
    if (this.frontier !== null && day === this.frontier) return;
    const startDay = this.frontier === null
      ? (this.minEventDay === null ? day + 1 : this.minEventDay)
      : this.frontier + 1;
    const stmt = this.db.prepare('INSERT INTO daily(day, revenue, deferred) VALUES (?, ?, ?)');
    const meta = this.db.prepare('INSERT INTO meta(key, value) VALUES (\'frontier\', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    this.db.exec('BEGIN');
    try {
      for (let d = startDay; d <= day; d++) {
        this.accRate += this.rateDiff.get(d) ?? 0n;
        const revenue = this.accRate + (this.pointAdj.get(d) ?? 0n);
        this.accRecognized += revenue;
        this.accPrepaid += this.prepaidDiff.get(d) ?? 0n;
        this.accRefunded += this.refundDiff.get(d) ?? 0n;
        const deferred = this.accPrepaid - this.accRefunded - this.accRecognized;
        stmt.run(d, revenue.toString(), deferred.toString());
      }
      meta.run(day.toString());
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    this.frontier = day;
  }

  /** Export daily revenue/deferred and the range revenue total for a closed range. */
  exportRange(from: string, to: string): RangeReport {
    const fromDay = parseDate(from);
    const toDay = parseDate(to);
    if (fromDay > toDay) {
      throw new Error(`invalid range: ${from} after ${to}`);
    }
    if (this.frontier === null || toDay > this.frontier) {
      throw new Error(`range ${from}..${to} is not fully closed`);
    }
    const stmt = this.db.prepare('SELECT day, revenue, deferred FROM daily WHERE day BETWEEN ? AND ? ORDER BY day');
    const rows = stmt.all(fromDay, toDay);
    const byDay = new Map<number, { revenue: bigint; deferred: bigint }>();
    for (const row of rows) {
      byDay.set(Number(row.day), { revenue: BigInt(row.revenue as string), deferred: BigInt(row.deferred as string) });
    }
    const days: DailyResult[] = [];
    let totalRevenue = 0n;
    for (let d = fromDay; d <= toDay; d++) {
      const row = byDay.get(d);
      const revenue = row ? row.revenue : 0n;
      const deferred = row ? row.deferred : 0n;
      days.push({ date: formatDate(d), revenue, deferred });
      totalRevenue += revenue;
    }
    return { from, to, totalRevenue, days };
  }

  close(): void {
    this.db.close();
  }

  private validateItem(item: PrepaidItem): ItemState {
    if (typeof item.id !== 'string' || item.id.length === 0) {
      throw new Error('item id must be a non-empty string');
    }
    if (this.items.has(item.id)) {
      throw new Error(`duplicate item id: ${item.id}`);
    }
    if (typeof item.amount !== 'bigint' || item.amount < 1n || item.amount > MAX_AMOUNT) {
      throw new Error(`item amount out of range: ${item.id}`);
    }
    const startDay = parseDate(item.startDate);
    const endDay = parseDate(item.endDate);
    const days = endDay - startDay;
    if (days < 1 || days > MAX_SERVICE_DAYS) {
      throw new Error(`service length out of range (1..3650 days): ${item.id}`);
    }
    if (this.frontier !== null && startDay <= this.frontier) {
      throw new Error(`item ${item.id} starts on or before the close frontier`);
    }
    return { amount: item.amount, startDay, endDay, refunds: [], refundedTotal: 0n };
  }

  private validateRefund(refund: Refund): ItemState {
    const item = this.items.get(refund.itemId);
    if (!item) {
      throw new Error(`unknown item for refund: ${refund.itemId}`);
    }
    if (typeof refund.amount !== 'bigint' || refund.amount < 1n) {
      throw new Error(`refund amount must be a positive bigint: ${refund.itemId}`);
    }
    const day = parseDate(refund.date);
    if (day < item.startDay) {
      throw new Error(`refund before service start: ${refund.itemId}`);
    }
    if (this.frontier !== null && day <= this.frontier) {
      throw new Error(`refund effective on or before the close frontier: ${refund.itemId}`);
    }
    if (item.refundedTotal + refund.amount > item.amount) {
      throw new Error(`refunds exceed item amount: ${refund.itemId}`);
    }
    return item;
  }

  private insertRefundPoint(item: ItemState, point: RefundPoint): void {
    const refunds = item.refunds;
    let lo = 0;
    let hi = refunds.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (refunds[mid].day < point.day) lo = mid + 1;
      else hi = mid;
    }
    refunds.splice(lo, 0, point);
  }

  private applyItemEvents(item: ItemState, sign: 1n | -1n): void {
    emitItemEvents(item.amount, item.startDay, item.endDay, item.refunds, {
      rateDiff: (day, delta) => this.addTo(this.rateDiff, day, delta * sign),
      pointAdj: (day, delta) => this.addTo(this.pointAdj, day, delta * sign),
      prepaid: (day, delta) => this.addTo(this.prepaidDiff, day, delta * sign),
      refundFlow: (day, delta) => this.addTo(this.refundDiff, day, delta * sign),
    });
  }

  private addTo(map: Map<number, bigint>, day: number, delta: bigint): void {
    const next = (map.get(day) ?? 0n) + delta;
    if (next === 0n) map.delete(day);
    else map.set(day, next);
    if (this.minEventDay === null || day < this.minEventDay) {
      this.minEventDay = day;
    }
  }

  /** Rebuild in-memory state after opening an existing database. */
  private rebuild(): void {
    const frontierRow = this.db.prepare('SELECT value FROM meta WHERE key = \'frontier\'').get();
    this.frontier = frontierRow ? Number(frontierRow.value) : null;

    const refundsByItem = new Map<string, RefundPoint[]>();
    for (const row of this.db.prepare('SELECT item_id, day, amount FROM refunds ORDER BY item_id, day').all()) {
      const itemId = row.item_id as string;
      let list = refundsByItem.get(itemId);
      if (!list) {
        list = [];
        refundsByItem.set(itemId, list);
      }
      list.push({ day: Number(row.day), amount: BigInt(row.amount as string) });
    }

    for (const row of this.db.prepare('SELECT id, amount, start_day, end_day FROM items').all()) {
      const id = row.id as string;
      const refunds = refundsByItem.get(id) ?? [];
      const state: ItemState = {
        amount: BigInt(row.amount as string),
        startDay: Number(row.start_day),
        endDay: Number(row.end_day),
        refunds,
        refundedTotal: refunds.reduce((sum, r) => sum + r.amount, 0n),
      };
      this.items.set(id, state);
      this.applyItemEvents(state, 1n);
    }

    if (this.frontier !== null && this.minEventDay !== null) {
      for (let d = this.minEventDay; d <= this.frontier; d++) {
        this.accRate += this.rateDiff.get(d) ?? 0n;
        this.accRecognized += this.accRate + (this.pointAdj.get(d) ?? 0n);
        this.accPrepaid += this.prepaidDiff.get(d) ?? 0n;
        this.accRefunded += this.refundDiff.get(d) ?? 0n;
      }
    }
  }
}
