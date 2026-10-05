import type {
  RateChange,
  SettlementPeriod,
  SettlementResult,
  WorkRecord,
} from "./types.js";
import { unionIntervals } from "./intervals.js";
import { Rational } from "./rational.js";
import { localToUtc, utcToLocalDate, weekStartUtc } from "./timezone.js";

const REGULAR_SECONDS_PER_WEEK = 40 * 3600;
const DAY_MS = 24 * 3600 * 1000;

/** 恒定费率且同属一个自然周的最小分段。 */
interface Segment {
  start: number;
  end: number;
  centsPerHour: number;
  weekStart: number;
}

interface WeekAccumulator {
  totalSeconds: number;
  baseCents: Rational;
  overtimeSecondsInPeriod: number;
}

function nextWeekStart(weekStart: number): number {
  const mondayDate = utcToLocalDate(weekStart);
  const [year, month, day] = mondayDate.split("-").map(Number);
  const nextMonday = new Date(Date.UTC(year, month - 1, day) + 7 * DAY_MS);
  const pad = (n: number) => String(n).padStart(2, "0");
  const nextDate = `${nextMonday.getUTCFullYear()}-${pad(nextMonday.getUTCMonth() + 1)}-${pad(nextMonday.getUTCDate())}`;
  return localToUtc(nextDate, 0);
}

/** 把一条合并后的工时区间切成恒定费率、单周归属的分段。 */
function splitInterval(
  start: number,
  end: number,
  sortedRates: RateChange[],
): Segment[] {
  const cuts = new Set<number>();
  for (const change of sortedRates) {
    if (change.effectiveUtc > start && change.effectiveUtc < end) {
      cuts.add(change.effectiveUtc);
    }
  }
  let boundary = nextWeekStart(weekStartUtc(start));
  while (boundary < end) {
    if (boundary > start) {
      cuts.add(boundary);
    }
    boundary = nextWeekStart(boundary);
  }
  const points = [start, ...[...cuts].sort((a, b) => a - b), end];
  const segments: Segment[] = [];
  let rateIndex = sortedRates.findIndex((c) => c.effectiveUtc > start);
  if (rateIndex === -1) {
    rateIndex = sortedRates.length;
  }
  for (let i = 0; i + 1 < points.length; i += 1) {
    const segStart = points[i];
    const segEnd = points[i + 1];
    while (
      rateIndex < sortedRates.length &&
      sortedRates[rateIndex].effectiveUtc <= segStart
    ) {
      rateIndex += 1;
    }
    if (rateIndex === 0) {
      throw new Error(
        `no rate covers work starting at ${segStart} (employee rate records incomplete)`,
      );
    }
    segments.push({
      start: segStart,
      end: segEnd,
      centsPerHour: sortedRates[rateIndex - 1].centsPerHour,
      weekStart: weekStartUtc(segStart),
    });
  }
  return segments;
}

/**
 * 按结算区间批量核算时薪员工的基础工资与加班补差。
 *
 * 调用方保证：费率覆盖全部工时；并提供结算区间触及的完整自然周内的
 * 全部工时与费率记录（包括结算范围之外的部分）。
 */
export function settlePayroll(
  workRecords: WorkRecord[],
  rateChanges: RateChange[],
  period: SettlementPeriod,
): SettlementResult[] {
  const periodStart = localToUtc(period.startLocalDate, 0);
  const periodEnd = localToUtc(period.endLocalDate, 0);
  if (periodEnd <= periodStart) {
    throw new Error("settlement period end must be after start");
  }

  const recordsByEmployee = new Map<string, WorkRecord[]>();
  for (const record of workRecords) {
    const list = recordsByEmployee.get(record.employeeId) ?? [];
    list.push(record);
    recordsByEmployee.set(record.employeeId, list);
  }
  const ratesByEmployee = new Map<string, RateChange[]>();
  for (const change of rateChanges) {
    const list = ratesByEmployee.get(change.employeeId) ?? [];
    list.push(change);
    ratesByEmployee.set(change.employeeId, list);
  }

  const results: SettlementResult[] = [];
  for (const [employeeId, records] of recordsByEmployee) {
    const sortedRates = (ratesByEmployee.get(employeeId) ?? [])
      .slice()
      .sort((a, b) => a.effectiveUtc - b.effectiveUtc);
    const merged = unionIntervals(
      records.map((r) => ({ start: r.startUtc, end: r.endUtc })),
    );

    const segments: Segment[] = [];
    for (const interval of merged) {
      segments.push(...splitInterval(interval.start, interval.end, sortedRates));
    }

    const weeks = new Map<number, WeekAccumulator>();
    const weekOf = (weekStart: number): WeekAccumulator => {
      let acc = weeks.get(weekStart);
      if (acc === undefined) {
        acc = { totalSeconds: 0, baseCents: Rational.zero(), overtimeSecondsInPeriod: 0 };
        weeks.set(weekStart, acc);
      }
      return acc;
    };

    let basePayInPeriod = Rational.zero();
    let currentWeekStart = -1;
    let weekElapsedSeconds = 0;

    for (const segment of segments) {
      const length = segment.end - segment.start;
      const week = weekOf(segment.weekStart);
      week.totalSeconds += length;
      week.baseCents = week.baseCents.add(
        Rational.of(BigInt(segment.centsPerHour) * BigInt(length), 3600n),
      );

      if (segment.weekStart !== currentWeekStart) {
        currentWeekStart = segment.weekStart;
        weekElapsedSeconds = 0;
      }
      const regularSeconds = Math.max(
        0,
        Math.min(length, REGULAR_SECONDS_PER_WEEK - weekElapsedSeconds),
      );
      weekElapsedSeconds += length;
      const overtimeStart = segment.start + regularSeconds;

      const payStart = Math.max(segment.start, periodStart);
      const payEnd = Math.min(segment.end, periodEnd);
      if (payEnd > payStart) {
        basePayInPeriod = basePayInPeriod.add(
          Rational.of(BigInt(segment.centsPerHour) * BigInt(payEnd - payStart), 3600n),
        );
        const otStart = Math.max(overtimeStart, payStart);
        if (payEnd > otStart) {
          week.overtimeSecondsInPeriod += payEnd - otStart;
        }
      }
    }

    let overtimePremium = Rational.zero();
    for (const week of weeks.values()) {
      if (week.overtimeSecondsInPeriod > 0) {
        // 0.5 * 整周平均时薪 * 加班小时数
        //     = 0.5 * (整周基础工资 / 整周秒数) * 区间加班秒数
        overtimePremium = overtimePremium.add(
          week.baseCents
            .mul(Rational.of(BigInt(week.overtimeSecondsInPeriod)))
            .div(Rational.of(2n * BigInt(week.totalSeconds))),
        );
      }
    }

    results.push({
      employeeId,
      basePay: basePayInPeriod,
      overtimePremium,
      totalRoundedCents: basePayInPeriod.add(overtimePremium).roundHalfUp(),
    });
  }

  results.sort((a, b) => (a.employeeId < b.employeeId ? -1 : 1));
  return results;
}
