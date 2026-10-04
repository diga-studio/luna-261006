/** Half-open day interval [start, end); end may be Number.POSITIVE_INFINITY. */
export interface Interval {
  start: number;
  end: number;
}

/** Sorted, disjoint, non-adjacent list of intervals. */
export type IntervalList = Interval[];

export function intersect(a: IntervalList, b: IntervalList): IntervalList {
  const out: IntervalList = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const start = Math.max(a[i].start, b[j].start);
    const end = Math.min(a[i].end, b[j].end);
    if (start < end) out.push({ start, end });
    if (a[i].end < b[j].end) i++;
    else j++;
  }
  return out;
}

export function union(a: IntervalList, b: IntervalList): IntervalList {
  const out: IntervalList = [];
  let i = 0;
  let j = 0;
  const push = (iv: Interval) => {
    const last = out[out.length - 1];
    if (last && iv.start <= last.end) {
      if (iv.end > last.end) last.end = iv.end;
    } else {
      out.push({ start: iv.start, end: iv.end });
    }
  };
  while (i < a.length || j < b.length) {
    if (j >= b.length || (i < a.length && a[i].start < b[j].start)) push(a[i++]);
    else push(b[j++]);
  }
  return out;
}

export function isSubset(a: IntervalList, b: IntervalList): boolean {
  let j = 0;
  for (const iv of a) {
    while (j < b.length && b[j].end <= iv.start) j++;
    if (j >= b.length) return false;
    if (iv.start < b[j].start || iv.end > b[j].end) return false;
  }
  return true;
}

export function firstDay(a: IntervalList): number {
  if (a.length === 0) throw new Error("firstDay of empty interval list");
  return a[0].start;
}
