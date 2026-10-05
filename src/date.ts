/**
 * Calendar day handling. Days are represented as an integer day number
 * (days since 0000-03-01, Howard Hinnant's civil calendar algorithm) so
 * arithmetic is timezone-free. Valid input range: years 2000..2099.
 */

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Days from civil date, Howard Hinnant's algorithm (proleptic Gregorian). */
function daysFromCivil(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400; // [0, 399]
  const mp = (m + 9) % 12; // [0, 11], March = 0
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468; // days since 1970-01-01
}

function isLeap(y: number): boolean {
  return y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
}

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Parse "YYYY-MM-DD" into a day number. Throws on invalid input. */
export function parseDate(text: string): number {
  const m = DATE_RE.exec(text);
  if (m === null) {
    throw new Error(`invalid date "${text}": expected "YYYY-MM-DD"`);
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (year < 2000 || year > 2099) {
    throw new Error(`invalid date "${text}": year must be in 2000..2099`);
  }
  if (month < 1 || month > 12) {
    throw new Error(`invalid date "${text}": bad month`);
  }
  const maxDay = MONTH_DAYS[month - 1] + (month === 2 && isLeap(year) ? 1 : 0);
  if (day < 1 || day > maxDay) {
    throw new Error(`invalid date "${text}": bad day of month`);
  }
  return daysFromCivil(year, month, day);
}

/** True if the string is a valid calendar date in the supported range. */
export function isValidDate(text: string): boolean {
  try {
    parseDate(text);
    return true;
  } catch {
    return false;
  }
}
