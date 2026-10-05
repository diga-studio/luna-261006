/**
 * 独立核算标准：逐项目、逐日按业务定义直接计算。
 * 与库内实现无任何共享代码，用于对照验证。
 */
export interface OracleItem {
  id: string;
  amount: bigint;
  startDay: number; // UTC 日序号
  days: number; // 服务天数
}

export interface OracleRefund {
  itemId: string;
  day: number;
  amount: bigint;
}

export interface OracleDay {
  revenue: bigint;
  deferred: bigint;
}

/** 单项目截至 day 的应累计确认额 F(day)。 */
export function recognized(item: OracleItem, refunds: OracleRefund[], day: number): bigint {
  let refunded = 0n;
  for (const r of refunds) if (r.day <= day) refunded += r.amount;
  const net = item.amount - refunded;
  const k = Math.max(0, Math.min(item.days, day - item.startDay + 1));
  if (k === 0) return 0n;
  if (k === item.days) return net;
  return (net / BigInt(item.days)) * BigInt(k);
}

/** 逐日计算 [fromDay, toDay] 的收入与期末递延余额（全项目汇总）。 */
export function oracleRange(
  items: OracleItem[],
  refunds: OracleRefund[],
  fromDay: number,
  toDay: number,
): Map<number, OracleDay> {
  const refundsByItem = new Map<string, OracleRefund[]>();
  for (const r of refunds) {
    let list = refundsByItem.get(r.itemId);
    if (!list) refundsByItem.set(r.itemId, (list = []));
    list.push(r);
  }
  const result = new Map<number, OracleDay>();
  for (let d = fromDay; d <= toDay; d++) result.set(d, { revenue: 0n, deferred: 0n });
  for (const item of items) {
    const itemRefunds = refundsByItem.get(item.id) ?? [];
    let prev = recognized(item, itemRefunds, fromDay - 1);
    for (let d = fromDay; d <= toDay; d++) {
      const cur = recognized(item, itemRefunds, d);
      let refunded = 0n;
      for (const r of itemRefunds) if (r.day <= d) refunded += r.amount;
      const prepaid = d >= item.startDay ? item.amount : 0n;
      const cell = result.get(d)!;
      cell.revenue += cur - prev;
      cell.deferred += prepaid - refunded - cur;
      prev = cur;
    }
  }
  return result;
}
