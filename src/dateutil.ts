const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parse an ISO YYYY-MM-DD date into a day number (days since 1970-01-01, UTC). */
export function parseDate(iso: string): number {
  const m = DATE_RE.exec(iso);
  if (!m) {
    throw new Error(`invalid date: ${iso}`);
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new Error(`invalid date: ${iso}`);
  }
  return daysFromCivil(year, month, day);
}

/** Format a day number back into an ISO YYYY-MM-DD date. */
export function formatDate(day: number): string {
  const [year, month, dom] = civilFromDays(day);
  const yy = year.toString().padStart(4, '0');
  const mm = month.toString().padStart(2, '0');
  const dd = dom.toString().padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function isLeap(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  const lengths = [31, isLeap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return lengths[month - 1];
}

// Howard Hinnant's days_from_civil / civil_from_days (public domain algorithms).

function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = (month + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function civilFromDays(z: number): [number, number, number] {
  const zz = z + 719468;
  const era = Math.floor(zz / 146097);
  const doe = zz - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const year = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const dom = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return [month <= 2 ? year + 1 : year, month, dom];
}
