import type { Month } from './types';

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function assertMonth(month: Month): void {
  if (!MONTH_RE.test(month)) {
    throw new Error(`invalid month: ${JSON.stringify(month)}, expected YYYY-MM`);
  }
}

/** 返回 [from, to] 闭区间内的全部月份（含两端），要求 from <= to */
export function monthRange(from: Month, to: Month): Month[] {
  assertMonth(from);
  assertMonth(to);
  if (from > to) {
    throw new Error(`month range inverted: ${from} > ${to}`);
  }
  const result: Month[] = [];
  let year = Number(from.slice(0, 4));
  let mon = Number(from.slice(5, 7));
  while (true) {
    const current = `${year}-${String(mon).padStart(2, '0')}`;
    result.push(current);
    if (current === to) break;
    mon += 1;
    if (mon > 12) {
      mon = 1;
      year += 1;
    }
  }
  return result;
}
