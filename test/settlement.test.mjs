import test from "node:test";
import assert from "node:assert/strict";
import { settlePayroll } from "../dist/index.js";

const utc = (iso) => Math.floor(Date.parse(iso) / 1000);

// ---------- independent exact rational arithmetic (reference) ----------
function gcd(a, b) {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}
function frac(n, d = 1n) {
  n = BigInt(n);
  d = BigInt(d);
  if (n === 0n) return [0n, 1n];
  const g = gcd(n, d);
  return [n / g, d / g];
}
function fadd([an, ad], [bn, bd]) {
  return frac(an * bd + bn * ad, ad * bd);
}
function feq([an, ad], [bn, bd]) {
  return an * bd === bn * ad;
}
const exactOf = (r) => [r.numerator, r.denominator];

// ======================================================================
// Scenario 1: month-end mid-week, >40h before month-end, mid-week raise.
// Week = Mon 2026-03-30 .. Mon 2026-04-06 (local, EDT = UTC-4).
// Shifts (local): Mon 03:00-24:00 (21h), Tue 00:00-21:00 (21h),
//                 Wed 09:00-17:00 (8h).
// Rates: 2000c/h until Wed 12:00 local, then 3000c/h.
// Full week: 50h, base = 2000*45 + 3000*5 = 105000c, avg = 2100c/h,
// OT = 10h, premium = 0.5 * 2100 * 10 = 10500c.
// ======================================================================
const S1_RECORDS = [
  { employeeId: "e1", startUtc: utc("2026-03-30T07:00:00Z"), endUtc: utc("2026-03-31T04:00:00Z") },
  { employeeId: "e1", startUtc: utc("2026-03-31T04:00:00Z"), endUtc: utc("2026-04-01T01:00:00Z") },
  { employeeId: "e1", startUtc: utc("2026-04-01T13:00:00Z"), endUtc: utc("2026-04-01T21:00:00Z") },
];
const S1_RATES = [
  { employeeId: "e1", effectiveUtc: utc("2026-03-01T00:00:00Z"), centsPerHour: 2000 },
  { employeeId: "e1", effectiveUtc: utc("2026-04-01T16:00:00Z"), centsPerHour: 3000 }, // Wed 12:00 local
];
const PERIOD_A = { startDate: "2026-03-01", endDate: "2026-04-01" };
const PERIOD_B = { startDate: "2026-04-01", endDate: "2026-05-01" };
const PERIOD_AB = { startDate: "2026-03-01", endDate: "2026-05-01" };

test("scenario 1: adjacent periods sum to combined period (exact)", () => {
  const [a] = settlePayroll(S1_RECORDS, S1_RATES, PERIOD_A);
  const [b] = settlePayroll(S1_RECORDS, S1_RATES, PERIOD_B);
  const [ab] = settlePayroll(S1_RECORDS, S1_RATES, PERIOD_AB);

  // Independent exact expectations.
  assert.ok(feq(exactOf(a.exactBasePay), frac(84000n))); // 42h * 2000
  assert.ok(feq(exactOf(b.exactBasePay), frac(21000n))); // 3h*2000 + 5h*3000
  assert.ok(feq(exactOf(ab.exactBasePay), frac(105000n)));
  // Premium uses full-week average rate 2100c/h even for the earlier period.
  assert.ok(feq(exactOf(a.exactOvertimePremium), frac(2100n))); // 0.5*2100*2h
  assert.ok(feq(exactOf(b.exactOvertimePremium), frac(8400n))); // 0.5*2100*8h
  assert.ok(feq(exactOf(ab.exactOvertimePremium), frac(10500n)));

  // Unrounded amounts are additive across the adjacent periods.
  assert.ok(feq(fadd(exactOf(a.exactBasePay), exactOf(b.exactBasePay)), exactOf(ab.exactBasePay)));
  assert.ok(feq(fadd(exactOf(a.exactOvertimePremium), exactOf(b.exactOvertimePremium)), exactOf(ab.exactOvertimePremium)));
  assert.ok(feq(fadd(exactOf(a.exactTotal), exactOf(b.exactTotal)), exactOf(ab.exactTotal)));

  assert.equal(ab.totalCents, 115500);
});

test("scenario 1: earlier period OT premium reflects later-week rate", () => {
  const [a] = settlePayroll(S1_RECORDS, S1_RATES, PERIOD_A);
  // Naive same-rate premium would be 0.5*2000*2 = 2000c; correct is 2100c.
  assert.equal(a.overtimePremiumCents, 2100);
  assert.equal(a.basePayCents, 84000);
  assert.equal(a.totalCents, 86100);
});

test("scenario 1: record order and contiguous splits do not change results", () => {
  // Split every shift into 1-hour contiguous pieces and shuffle.
  const split = [];
  for (const r of S1_RECORDS) {
    for (let s = r.startUtc; s < r.endUtc; s += 3600) {
      split.push({ employeeId: r.employeeId, startUtc: s, endUtc: Math.min(s + 3600, r.endUtc) });
    }
  }
  const shuffled = [...split].reverse();
  const [ref] = settlePayroll(S1_RECORDS, S1_RATES, PERIOD_AB);
  const [got] = settlePayroll(shuffled, S1_RATES, PERIOD_AB);
  assert.ok(feq(exactOf(got.exactTotal), exactOf(ref.exactTotal)));
  assert.ok(feq(exactOf(got.exactBasePay), exactOf(ref.exactBasePay)));
  assert.ok(feq(exactOf(got.exactOvertimePremium), exactOf(ref.exactOvertimePremium)));
  assert.equal(got.totalCents, ref.totalCents);
});

// ======================================================================
// Scenario 2: DST transition days, duplicates, overlaps, cross-week.
// ======================================================================
const RATE_1800 = [{ employeeId: "e2", effectiveUtc: utc("2026-01-01T00:00:00Z"), centsPerHour: 1800 }];

test("scenario 2 spring: local 00:00-04:00 shift counts 3h; dups/overlap/cross-week", () => {
  const records = [
    // 39h earlier in the week: Mon-Wed 08:00-21:00 local (EST, UTC-5).
    { employeeId: "e2", startUtc: utc("2026-03-02T13:00:00Z"), endUtc: utc("2026-03-03T02:00:00Z") },
    { employeeId: "e2", startUtc: utc("2026-03-03T13:00:00Z"), endUtc: utc("2026-03-04T02:00:00Z") },
    { employeeId: "e2", startUtc: utc("2026-03-04T13:00:00Z"), endUtc: utc("2026-03-05T02:00:00Z") },
    // Spring-forward Sunday 2026-03-08 local 00:00-04:00 = 05:00Z-08:00Z (3h).
    { employeeId: "e2", startUtc: utc("2026-03-08T05:00:00Z"), endUtc: utc("2026-03-08T08:00:00Z") },
    // Exact duplicate of the Sunday shift.
    { employeeId: "e2", startUtc: utc("2026-03-08T05:00:00Z"), endUtc: utc("2026-03-08T08:00:00Z") },
    // Overlapping record: adds only 08:00Z-09:00Z (1h).
    { employeeId: "e2", startUtc: utc("2026-03-08T06:00:00Z"), endUtc: utc("2026-03-08T09:00:00Z") },
    // Cross-week: week boundary Mon 2026-03-09 00:00 local = 04:00Z.
    // 02:00Z-04:00Z -> week of Mar 2 (OT), 04:00Z-06:00Z -> week of Mar 9.
    { employeeId: "e2", startUtc: utc("2026-03-09T02:00:00Z"), endUtc: utc("2026-03-09T06:00:00Z") },
  ];
  const period1 = { startDate: "2026-03-01", endDate: "2026-03-09" };
  const period2 = { startDate: "2026-03-09", endDate: "2026-04-01" };
  const full = { startDate: "2026-03-01", endDate: "2026-04-01" };

  // Week of Mar 2: 39 + 3 + 1 + 2 = 45h -> 40 regular + 5 OT, avg rate 1800.
  const [p1] = settlePayroll(records, RATE_1800, period1);
  assert.ok(feq(exactOf(p1.exactBasePay), frac(81000n))); // 45h * 1800
  assert.ok(feq(exactOf(p1.exactOvertimePremium), frac(4500n))); // 0.5*1800*5
  // Week of Mar 9: 2h regular.
  const [p2] = settlePayroll(records, RATE_1800, period2);
  assert.ok(feq(exactOf(p2.exactBasePay), frac(3600n)));
  assert.ok(feq(exactOf(p2.exactOvertimePremium), frac(0n)));
  // Combined.
  const [pf] = settlePayroll(records, RATE_1800, full);
  assert.ok(feq(exactOf(pf.exactBasePay), frac(84600n)));
  assert.ok(feq(exactOf(pf.exactOvertimePremium), frac(4500n)));
  assert.equal(pf.totalCents, 89100);
});

const RATE_2400 = [{ employeeId: "e3", effectiveUtc: utc("2026-01-01T00:00:00Z"), centsPerHour: 2400 }];

test("scenario 2 fall: local 00:00-04:00 shift counts 5h; dups/overlap/cross-week", () => {
  const records = [
    // Fall-back Sunday 2026-11-01 local 00:00-04:00 = 04:00Z-09:00Z (5h).
    { employeeId: "e3", startUtc: utc("2026-11-01T04:00:00Z"), endUtc: utc("2026-11-01T09:00:00Z") },
    // Exact duplicate.
    { employeeId: "e3", startUtc: utc("2026-11-01T04:00:00Z"), endUtc: utc("2026-11-01T09:00:00Z") },
    // Overlapping record: adds only 09:00Z-10:00Z (1h).
    { employeeId: "e3", startUtc: utc("2026-11-01T06:00:00Z"), endUtc: utc("2026-11-01T10:00:00Z") },
    // Cross-week: boundary Mon 2026-11-02 00:00 local = 05:00Z (EST).
    // 03:00Z-05:00Z -> week of Oct 26, 05:00Z-07:00Z -> week of Nov 2.
    { employeeId: "e3", startUtc: utc("2026-11-02T03:00:00Z"), endUtc: utc("2026-11-02T07:00:00Z") },
  ];
  const period1 = { startDate: "2026-10-26", endDate: "2026-11-02" };
  const period2 = { startDate: "2026-11-02", endDate: "2026-11-09" };

  const [p1] = settlePayroll(records, RATE_2400, period1);
  assert.ok(feq(exactOf(p1.exactBasePay), frac(19200n))); // (5+1+2)h * 2400
  assert.ok(feq(exactOf(p1.exactOvertimePremium), frac(0n)));
  const [p2] = settlePayroll(records, RATE_2400, period2);
  assert.ok(feq(exactOf(p2.exactBasePay), frac(4800n))); // 2h * 2400
  assert.ok(feq(exactOf(p2.exactOvertimePremium), frac(0n)));
});

// ======================================================================
// Rounding: half-up exactly at half a cent.
// ======================================================================
test("rounding: half cent rounds up, below half rounds down", () => {
  const rates = [{ employeeId: "e4", effectiveUtc: utc("2026-03-01T00:00:00Z"), centsPerHour: 1 }];
  const period = { startDate: "2026-03-01", endDate: "2026-03-08" };
  const mon = utc("2026-03-02T13:00:00Z"); // a Monday, local morning
  const [half] = settlePayroll(
    [{ employeeId: "e4", startUtc: mon, endUtc: mon + 1800 }],
    rates,
    period,
  );
  assert.equal(half.totalCents, 1); // 0.5c -> 1c
  const [below] = settlePayroll(
    [{ employeeId: "e4", startUtc: mon, endUtc: mon + 1799 }],
    rates,
    period,
  );
  assert.equal(below.totalCents, 0);
});
