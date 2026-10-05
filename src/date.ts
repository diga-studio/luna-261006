const DAY_MS = 86400000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 解析 YYYY-MM-DD 为 UTC 日序号（自 1970-01-01 的天数）。非法日期抛错。 */
export function parseDate(s: string): number {
  const m = DATE_RE.exec(s);
  if (!m) throw new Error(`invalid date: ${JSON.stringify(s)}`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) {
    throw new Error(`invalid date: ${JSON.stringify(s)}`);
  }
  const ms = Date.UTC(y, mo - 1, d);
  const day = ms / DAY_MS;
  // 回读校验，拒绝 2024-02-30 之类的进位日期
  if (formatDate(day) !== s) throw new Error(`invalid date: ${JSON.stringify(s)}`);
  return day;
}

/** 将 UTC 日序号格式化为 YYYY-MM-DD。 */
export function formatDate(day: number): string {
  const dt = new Date(day * DAY_MS);
  const y = dt.getUTCFullYear();
  const mo = dt.getUTCMonth() + 1;
  const d = dt.getUTCDate();
  const yy = y < 0 ? `-${String(-y).padStart(4, "0")}` : String(y).padStart(4, "0");
  return `${yy}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
