/**
 * Calendar handling. Dates are proleptic Gregorian calendar days in the range
 * 2000-01-01..2099-12-31, represented internally as a day number
 * (days since 2000-01-01). No time-of-day component exists.
 */

export const MIN_YEAR = 2000;
export const MAX_YEAR = 2099;

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

/** Days from civil epoch 1970-01-01 (Howard Hinnant's algorithm, non-negative years). */
function daysFromCivil(year: number, month: number, day: number): number {
  const adjustedYear = month <= 2 ? year - 1 : year;
  const era = Math.floor(adjustedYear / 400);
  const yearOfEra = adjustedYear - era * 400;
  const shiftedMonth = month + (month > 2 ? -3 : 9);
  const dayOfYear = Math.floor((153 * shiftedMonth + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

const DAY_NUMBER_ORIGIN = daysFromCivil(2000, 1, 1);

/** Parses "YYYY-MM-DD" into a day number (days since 2000-01-01). Throws on invalid input. */
export function parseDate(text: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (match === null) {
    throw new Error(`Invalid date (expected YYYY-MM-DD): ${text}`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < MIN_YEAR || year > MAX_YEAR) {
    throw new Error(`Year out of range ${MIN_YEAR}..${MAX_YEAR}: ${text}`);
  }
  if (month < 1 || month > 12) {
    throw new Error(`Invalid month: ${text}`);
  }
  const monthLength = DAYS_IN_MONTH[month - 1] + (month === 2 && isLeapYear(year) ? 1 : 0);
  if (day < 1 || day > monthLength) {
    throw new Error(`Invalid day of month: ${text}`);
  }
  return daysFromCivil(year, month, day) - DAY_NUMBER_ORIGIN;
}
