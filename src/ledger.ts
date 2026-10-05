import { DatabaseSync } from "node:sqlite";
import { parseDate, formatDate } from "./date";
import { buildItemEvents, RevEvent } from "./events";
import { ItemInput, RefundInput, RangeReport, DayResult } from "./types";

const MAX_AMOUNT = 10n ** 18n;
const MAX_SERVICE_DAYS = 3650;

interface ItemState {
  amount: bigint;
  startDay: number;
  days: number;
  refundTotal: bigint;
}

export class RevenueLedger {
  private db: DatabaseSync;
  private items = new Map<string, ItemState>();
  /** 每日收入差分：day -> delta */
  private revDiff = new Map<number, bigint>();
  /** 预付款生效差分：day -> 当日生效预付款合计 */
  private prepaidDiff = new Map<number, bigint>();
  /** 退款生效差分：day -> 当日生效退款合计 */
  private refundDiff = new Map<number, bigint>();
  /** 已封截止日序号，未封账为 null */
  private frontierDay: number | null = null;
  /** 封账推进游标处的累计量（截至 frontierDay） */
  private revAt = 0n; // frontierDay 当日收入（差分前缀和）
  private revCum = 0n; // 累计已确认收入
  private prepaidCum = 0n; // 累计已生效预付款
  private refundCum = 0n; // 累计已生效退款
  private stmtRefundDays;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY,
        amount TEXT NOT NULL,
        start_day INTEGER NOT NULL,
        days INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS refunds (
        item_id TEXT NOT NULL,
        day INTEGER NOT NULL,
        amount TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_refunds_item ON refunds(item_id);
      CREATE TABLE IF NOT EXISTS daily (
        day INTEGER PRIMARY KEY,
        revenue TEXT NOT NULL,
        deferred TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    this.stmtRefundDays = this.db.prepare("SELECT day, amount FROM refunds WHERE item_id = ? ORDER BY day");
    this.loadState();
  }

  /** 从数据库重建内存状态（差分数组与封账游标）。 */
  private loadState(): void {
    const meta = new Map<string, string>();
    for (const row of this.db.prepare("SELECT key, value FROM meta").all() as Array<{ key: string; value: string }>) {
      meta.set(row.key, row.value);
    }
    const frontier = meta.get("frontier");
    if (frontier !== undefined) {
      this.frontierDay = Number(frontier);
      this.revAt = BigInt(meta.get("revAt") ?? "0");
      this.revCum = BigInt(meta.get("revCum") ?? "0");
      this.prepaidCum = BigInt(meta.get("prepaidCum") ?? "0");
      this.refundCum = BigInt(meta.get("refundCum") ?? "0");
    }

    // 退款按项目聚合（同日合并），仅暂存于本函数作用域
    const refundsByItem = new Map<string, Map<number, bigint>>();
    for (const row of this.db.prepare("SELECT item_id, day, amount FROM refunds").all() as Array<{ item_id: string; day: number; amount: string }>) {
      let byDay = refundsByItem.get(row.item_id);
      if (!byDay) refundsByItem.set(row.item_id, (byDay = new Map()));
      byDay.set(row.day, (byDay.get(row.day) ?? 0n) + BigInt(row.amount));
      this.addTo(this.refundDiff, row.day, BigInt(row.amount));
    }

    for (const row of this.db.prepare("SELECT id, amount, start_day, days FROM items").all() as Array<{ id: string; amount: string; start_day: number; days: number }>) {
      const amount = BigInt(row.amount);
      const byDay = refundsByItem.get(row.id);
      let refundTotal = 0n;
      const refunds: Array<{ day: number; amount: bigint }> = [];
      if (byDay) {
        for (const [day, amt] of [...byDay.entries()].sort((a, b) => a[0] - b[0])) {
          refunds.push({ day, amount: amt });
          refundTotal += amt;
        }
      }
      this.applyEvents(buildItemEvents(amount, row.start_day, row.days, refunds), 1n);
      this.addTo(this.prepaidDiff, row.start_day, amount);
      this.items.set(row.id, { amount, startDay: row.start_day, days: row.days, refundTotal });
    }
  }

  private addTo(map: Map<number, bigint>, day: number, delta: bigint): void {
    map.set(day, (map.get(day) ?? 0n) + delta);
  }

  private applyEvents(events: ReadonlyArray<RevEvent>, sign: bigint): void {
    for (const e of events) this.addTo(this.revDiff, e.day, e.delta * sign);
  }

  private ensureOpenFor(day: number): void {
    if (this.frontierDay !== null && day <= this.frontierDay) {
      throw new Error(`event at ${formatDate(day)} is at or before closed frontier ${formatDate(this.frontierDay)}`);
    }
  }

  /** 读取某项目已落库的退款（按日升序、同日合并）。 */
  private readItemRefunds(itemId: string): Array<{ day: number; amount: bigint }> {
    const rows = this.stmtRefundDays.all(itemId) as Array<{ day: number; amount: string }>;
    const merged: Array<{ day: number; amount: bigint }> = [];
    for (const row of rows) {
      const amount = BigInt(row.amount);
      const last = merged[merged.length - 1];
      if (last && last.day === row.day) last.amount += amount;
      else merged.push({ day: row.day, amount });
    }
    return merged;
  }

  recordItems(items: ItemInput[]): void {
    if (items.length === 0) return;
    // 先完成全部校验与内存计算，再落库，保证批次原子性
    const prepared: Array<{ input: ItemInput; amount: bigint; startDay: number; days: number; events: RevEvent[] }> = [];
    const seen = new Set<string>();
    for (const item of items) {
      if (typeof item.id !== "string" || item.id.length === 0) throw new Error("item id must be a non-empty string");
      if (this.items.has(item.id) || seen.has(item.id)) throw new Error(`duplicate item id: ${item.id}`);
      seen.add(item.id);
      const amount = item.amount;
      if (typeof amount !== "bigint" || amount < 1n || amount > MAX_AMOUNT) {
        throw new Error(`item ${item.id}: amount out of range`);
      }
      const startDay = parseDate(item.startDate);
      const endDay = parseDate(item.endDate);
      const days = endDay - startDay;
      if (days < 1 || days > MAX_SERVICE_DAYS) throw new Error(`item ${item.id}: service days out of range`);
      this.ensureOpenFor(startDay);
      prepared.push({ input: item, amount, startDay, days, events: buildItemEvents(amount, startDay, days, []) });
    }

    const insert = this.db.prepare("INSERT INTO items (id, amount, start_day, days) VALUES (?, ?, ?, ?)");
    this.db.exec("BEGIN");
    try {
      for (const p of prepared) insert.run(p.input.id, p.amount.toString(), p.startDay, p.days);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    for (const p of prepared) {
      this.items.set(p.input.id, { amount: p.amount, startDay: p.startDay, days: p.days, refundTotal: 0n });
      this.applyEvents(p.events, 1n);
      this.addTo(this.prepaidDiff, p.startDay, p.amount);
    }
  }

  recordRefunds(refunds: RefundInput[]): void {
    if (refunds.length === 0) return;
    // 1) 逐条校验并按项目归集本批新增（同日合并）
    const added = new Map<string, { byDay: Map<number, bigint>; total: bigint }>();
    for (const refund of refunds) {
      const item = this.items.get(refund.itemId);
      if (!item) throw new Error(`unknown item: ${refund.itemId}`);
      const amount = refund.amount;
      if (typeof amount !== "bigint" || amount < 1n || amount > MAX_AMOUNT) {
        throw new Error(`refund for ${refund.itemId}: amount out of range`);
      }
      const day = parseDate(refund.effectiveDate);
      if (day < item.startDay) throw new Error(`refund for ${refund.itemId} predates service start`);
      this.ensureOpenFor(day);

      let entry = added.get(refund.itemId);
      if (!entry) added.set(refund.itemId, (entry = { byDay: new Map(), total: 0n }));
      if (item.refundTotal + entry.total + amount > item.amount) {
        throw new Error(`refunds for ${refund.itemId} exceed original amount`);
      }
      entry.byDay.set(day, (entry.byDay.get(day) ?? 0n) + amount);
      entry.total += amount;
    }

    // 2) 每个受影响项目：读库内既有退款，与本批合并后重算事件表
    const updates: Array<{ itemId: string; oldEvents: RevEvent[]; newEvents: RevEvent[] }> = [];
    for (const [itemId, entry] of added) {
      const item = this.items.get(itemId)!;
      const existing = this.readItemRefunds(itemId);
      const merged = mergeRefundLists(existing, entry.byDay);
      updates.push({
        itemId,
        oldEvents: buildItemEvents(item.amount, item.startDay, item.days, existing),
        newEvents: buildItemEvents(item.amount, item.startDay, item.days, merged),
      });
    }

    const insert = this.db.prepare("INSERT INTO refunds (item_id, day, amount) VALUES (?, ?, ?)");
    this.db.exec("BEGIN");
    try {
      for (const refund of refunds) insert.run(refund.itemId, parseDate(refund.effectiveDate), refund.amount.toString());
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    for (const { itemId, oldEvents, newEvents } of updates) {
      const item = this.items.get(itemId)!;
      this.applyEvents(oldEvents, -1n);
      this.applyEvents(newEvents, 1n);
      item.refundTotal += added.get(itemId)!.total;
    }
    for (const refund of refunds) {
      this.addTo(this.refundDiff, parseDate(refund.effectiveDate), refund.amount);
    }
  }

  advanceTo(toDate: string): void {
    const day = parseDate(toDate);
    if (this.frontierDay !== null) {
      if (day < this.frontierDay) throw new Error(`cannot move frontier backwards to ${toDate}`);
      if (day === this.frontierDay) return;
    }
    const start = this.frontierDay === null ? Math.min(this.earliestEventDay() ?? day, day) : this.frontierDay + 1;
    const insertDaily = this.db.prepare("INSERT INTO daily (day, revenue, deferred) VALUES (?, ?, ?)");
    const upsertMeta = this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    let revAt = this.revAt;
    let revCum = this.revCum;
    let prepaidCum = this.prepaidCum;
    let refundCum = this.refundCum;
    this.db.exec("BEGIN");
    try {
      for (let d = start; d <= day; d++) {
        revAt += this.revDiff.get(d) ?? 0n;
        revCum += revAt;
        prepaidCum += this.prepaidDiff.get(d) ?? 0n;
        refundCum += this.refundDiff.get(d) ?? 0n;
        const deferred = prepaidCum - refundCum - revCum;
        insertDaily.run(d, revAt.toString(), deferred.toString());
      }
      upsertMeta.run("frontier", String(day));
      upsertMeta.run("revAt", revAt.toString());
      upsertMeta.run("revCum", revCum.toString());
      upsertMeta.run("prepaidCum", prepaidCum.toString());
      upsertMeta.run("refundCum", refundCum.toString());
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    this.frontierDay = day;
    this.revAt = revAt;
    this.revCum = revCum;
    this.prepaidCum = prepaidCum;
    this.refundCum = refundCum;
  }

  /** 最早业务事件日；无任何事件时为 null。 */
  private earliestEventDay(): number | null {
    let min: number | null = null;
    for (const day of this.prepaidDiff.keys()) min = min === null ? day : Math.min(min, day);
    for (const day of this.revDiff.keys()) min = min === null ? day : Math.min(min, day);
    return min;
  }

  exportRange(fromDate: string, toDate: string): RangeReport {
    const from = parseDate(fromDate);
    const to = parseDate(toDate);
    if (from > to) throw new Error(`empty range: ${fromDate}..${toDate}`);
    if (this.frontierDay === null || to > this.frontierDay) {
      throw new Error(`range ${fromDate}..${toDate} is not fully closed`);
    }
    const rows = new Map<number, { revenue: bigint; deferred: bigint }>();
    for (const row of this.db.prepare("SELECT day, revenue, deferred FROM daily WHERE day >= ? AND day <= ? ORDER BY day").all(from, to) as Array<{ day: number; revenue: string; deferred: string }>) {
      rows.set(row.day, { revenue: BigInt(row.revenue), deferred: BigInt(row.deferred) });
    }
    // 首个封账日之前的日期无任何业务事件，收入与递延均为零
    const days: DayResult[] = [];
    let totalRevenue = 0n;
    for (let d = from; d <= to; d++) {
      const row = rows.get(d) ?? { revenue: 0n, deferred: 0n };
      days.push({ date: formatDate(d), revenue: row.revenue, deferred: row.deferred });
      totalRevenue += row.revenue;
    }
    return { from: fromDate, to: toDate, days, totalRevenue };
  }

  get frontier(): string | null {
    return this.frontierDay === null ? null : formatDate(this.frontierDay);
  }

  close(): void {
    this.db.close();
  }
}

/** 归并两个按日升序的退款表（同日合并）。 */
function mergeRefundLists(
  existing: Array<{ day: number; amount: bigint }>,
  added: Map<number, bigint>,
): Array<{ day: number; amount: bigint }> {
  const extra = [...added.entries()].map(([day, amount]) => ({ day, amount })).sort((a, b) => a.day - b.day);
  const merged: Array<{ day: number; amount: bigint }> = [];
  let i = 0;
  let j = 0;
  while (i < existing.length || j < extra.length) {
    let next: { day: number; amount: bigint };
    if (j >= extra.length || (i < existing.length && existing[i].day < extra[j].day)) {
      next = { day: existing[i].day, amount: existing[i].amount };
      i++;
    } else if (i >= existing.length || extra[j].day < existing[i].day) {
      next = { day: extra[j].day, amount: extra[j].amount };
      j++;
    } else {
      next = { day: existing[i].day, amount: existing[i].amount + extra[j].amount };
      i++;
      j++;
    }
    const last = merged[merged.length - 1];
    if (last && last.day === next.day) last.amount += next.amount;
    else merged.push(next);
  }
  return merged;
}
