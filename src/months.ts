import type { Month } from './types.js';

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** 校验月份格式 YYYY-MM。 */
export function assertMonth(month: Month): void {
  if (typeof month !== 'string' || !MONTH_RE.test(month)) {
    throw new Error(`invalid month: ${JSON.stringify(month)}, expected YYYY-MM`);
  }
}

/** 月份加 n 个月（n 可为负）。 */
export function addMonths(month: Month, n: number): Month {
  assertMonth(month);
  const year = Number(month.slice(0, 4));
  const mon = Number(month.slice(5, 7));
  const idx = year * 12 + (mon - 1) + n;
  const y = Math.floor(idx / 12);
  const m = (idx % 12) + 1;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}`;
}

/** 生成 [from, to] 闭区间的月份序列（要求 from <= to）。 */
export function monthRange(from: Month, to: Month): Month[] {
  assertMonth(from);
  assertMonth(to);
  if (from > to) {
    throw new Error(`month range inverted: ${from} > ${to}`);
  }
  const out: Month[] = [];
  let cur = from;
  while (cur <= to) {
    out.push(cur);
    cur = addMonths(cur, 1);
  }
  return out;
}
