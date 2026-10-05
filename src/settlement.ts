import { mergeEffectiveIntervals } from "./intervals.js";
import type { Interval } from "./intervals.js";
import { localMidnightToUtc, weekStartUtc } from "./timezone.js";
import type {
  EmployeeSettlement,
  RateChange,
  Rational,
  SettlementPeriod,
  TimeRecord,
} from "./types.js";

const REGULAR_LIMIT_SEC = 40 * 3600;
const WEEK_SLACK_SEC = 8 * 86400; // safely past any week end (max 7d + 1h DST)

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

function rational(num: bigint, den: bigint): Rational {
  if (den === 0n) throw new Error("zero denominator");
  if (num === 0n) return { numerator: 0n, denominator: 1n };
  const g = gcd(num, den);
  const n = num / g;
  const d = den / g;
  return d < 0n ? { numerator: -n, denominator: -d } : { numerator: n, denominator: d };
}

function addRational(a: Rational, b: Rational): Rational {
  return rational(
    a.numerator * b.denominator + b.numerator * a.denominator,
    a.denominator * b.denominator,
  );
}

/** Round a non-negative rational (in cents) half-up to integer cents. */
function roundHalfUp(r: Rational): number {
  if (r.numerator < 0n) throw new Error("negative amount");
  return Number((2n * r.numerator + r.denominator) / (2n * r.denominator));
}

interface RateSegment {
  start: number;
  end: number; // may be Infinity
  centsPerHour: number;
}

function buildRateSegments(rateChanges: RateChange[]): RateSegment[] {
  const sorted = [...rateChanges].sort(
    (a, b) => a.effectiveUtc - b.effectiveUtc,
  );
  return sorted.map((r, i) => ({
    start: r.effectiveUtc,
    end: i + 1 < sorted.length ? sorted[i + 1]!.effectiveUtc : Infinity,
    centsPerHour: r.centsPerHour,
  }));
}

/** Split an interval into per-week chunks keyed by week start (UTC sec). */
function splitByWeek(iv: Interval, out: Map<number, Interval[]>): void {
  let cursor = iv.start;
  while (cursor < iv.end) {
    const ws = weekStartUtc(cursor);
    const we = weekStartUtc(ws + WEEK_SLACK_SEC);
    const chunkEnd = Math.min(iv.end, we);
    let list = out.get(ws);
    if (!list) {
      list = [];
      out.set(ws, list);
    }
    list.push({ start: cursor, end: chunkEnd });
    cursor = chunkEnd;
  }
}

interface RatedInterval extends Interval {
  centsPerHour: number;
}

/** Intersect sorted disjoint intervals with sorted rate segments. */
function applyRates(weekIntervals: Interval[], rates: RateSegment[]): RatedInterval[] {
  const out: RatedInterval[] = [];
  let ri = 0;
  for (const iv of weekIntervals) {
    while (ri < rates.length && rates[ri]!.end <= iv.start) ri += 1;
    let k = ri;
    while (k < rates.length && rates[k]!.start < iv.end) {
      const seg = rates[k]!;
      const start = Math.max(iv.start, seg.start);
      const end = Math.min(iv.end, seg.end);
      if (start < end) out.push({ start, end, centsPerHour: seg.centsPerHour });
      k += 1;
    }
    if (ri >= rates.length && rates.length > 0) {
      // coverage guaranteed by caller; trailing segment has end=Infinity
    }
  }
  return out;
}

function overlapSeconds(iv: Interval, pStart: number, pEnd: number): number {
  const s = Math.max(iv.start, pStart);
  const e = Math.min(iv.end, pEnd);
  return e > s ? e - s : 0;
}

interface EmployeeTotals {
  base: Rational;
  premium: Rational;
}

function settleEmployee(
  records: TimeRecord[],
  rateChanges: RateChange[],
  periodStartUtc: number,
  periodEndUtc: number,
): EmployeeTotals {
  const effective = mergeEffectiveIntervals(records);
  const rates = buildRateSegments(rateChanges);
  const byWeek = new Map<number, Interval[]>();
  for (const iv of effective) splitByWeek(iv, byWeek);

  let base: Rational = { numerator: 0n, denominator: 1n };
  let premium: Rational = { numerator: 0n, denominator: 1n };

  for (const chunks of byWeek.values()) {
    chunks.sort((a, b) => a.start - b.start);
    const rated = applyRates(chunks, rates);

    let weekBaseNum = 0n; // cents * 3600 over the full week
    let weekTotalSec = 0;
    let payableBaseNum = 0n; // in-period portion, cents * 3600
    let payableOtSec = 0;
    let elapsed = 0; // effective seconds so far this week (regular/OT split)

    for (const seg of rated) {
      const len = seg.end - seg.start;
      const regularLen = Math.max(0, Math.min(len, REGULAR_LIMIT_SEC - elapsed));
      const otLen = len - regularLen;
      weekBaseNum += BigInt(seg.centsPerHour) * BigInt(len);
      weekTotalSec += len;
      if (regularLen > 0) {
        const inPeriod = overlapSeconds(
          { start: seg.start, end: seg.start + regularLen },
          periodStartUtc,
          periodEndUtc,
        );
        payableBaseNum += BigInt(seg.centsPerHour) * BigInt(inPeriod);
      }
      if (otLen > 0) {
        const otStart = seg.start + regularLen;
        payableBaseNum +=
          BigInt(seg.centsPerHour) *
          BigInt(overlapSeconds({ start: otStart, end: seg.end }, periodStartUtc, periodEndUtc));
        payableOtSec += overlapSeconds({ start: otStart, end: seg.end }, periodStartUtc, periodEndUtc);
      }
      elapsed += len;
    }

    // Base pay of in-period seconds: payableBaseNum / 3600 cents.
    base = addRational(base, rational(payableBaseNum, 3600n));
    if (payableOtSec > 0 && weekTotalSec > 0) {
      // Weekly average rate = weekBase / weekHours = weekBaseNum / weekTotalSec (cents/hour).
      // Premium = 0.5 * avgRate * otHours
      //         = weekBaseNum * payableOtSec / (2 * weekTotalSec * 3600) cents.
      premium = addRational(
        premium,
        rational(
          weekBaseNum * BigInt(payableOtSec),
          2n * BigInt(weekTotalSec) * 3600n,
        ),
      );
    }
  }

  return { base, premium };
}

/**
 * Settle base pay and overtime premium for hourly employees over a period.
 * Records may be duplicated/overlapping and in any order; amounts are exact
 * (rational arithmetic) and rounded half-up to cents only at the per-employee
 * total level.
 */
export function settlePayroll(
  records: TimeRecord[],
  rateChanges: RateChange[],
  period: SettlementPeriod,
): EmployeeSettlement[] {
  const periodStartUtc = localMidnightToUtc(period.startDate);
  const periodEndUtc = localMidnightToUtc(period.endDate);
  if (periodEndUtc <= periodStartUtc) {
    throw new Error("period end must be after period start");
  }

  const recordsByEmployee = new Map<string, TimeRecord[]>();
  for (const r of records) {
    let list = recordsByEmployee.get(r.employeeId);
    if (!list) {
      list = [];
      recordsByEmployee.set(r.employeeId, list);
    }
    list.push(r);
  }
  const ratesByEmployee = new Map<string, RateChange[]>();
  for (const rc of rateChanges) {
    let list = ratesByEmployee.get(rc.employeeId);
    if (!list) {
      list = [];
      ratesByEmployee.set(rc.employeeId, list);
    }
    list.push(rc);
  }

  const results: EmployeeSettlement[] = [];
  for (const [employeeId, recs] of [...recordsByEmployee.entries()].sort((a, b) =>
    a[0] < b[0] ? -1 : 1,
  )) {
    const rates = ratesByEmployee.get(employeeId) ?? [];
    if (rates.length === 0) {
      throw new Error(`no rate coverage for employee ${employeeId}`);
    }
    const { base, premium } = settleEmployee(recs, rates, periodStartUtc, periodEndUtc);
    const total = addRational(base, premium);
    results.push({
      employeeId,
      basePayCents: roundHalfUp(base),
      overtimePremiumCents: roundHalfUp(premium),
      totalCents: roundHalfUp(total),
      exactBasePay: base,
      exactOvertimePremium: premium,
      exactTotal: total,
    });
  }
  return results;
}
