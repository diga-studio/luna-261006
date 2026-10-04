const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = formatterCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatterCache.set(timeZone, fmt);
  }
  return fmt;
}

function parseWall(date: string, time: string): number {
  const [y, mo, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  return Date.UTC(y!, mo! - 1, d!, hh!, mm!);
}

/** 给定 UTC 时刻，返回该时区下的墙钟毫秒（把当地日期时间当作 UTC 解释）。 */
function wallAt(timeZone: string, utcMs: number): number {
  const parts = getFormatter(timeZone).formatToParts(new Date(utcMs));
  const vals: Record<string, number> = {};
  for (const p of parts) {
    if (p.type !== "literal") vals[p.type] = Number(p.value);
  }
  return Date.UTC(
    vals["year"]!,
    vals["month"]! - 1,
    vals["day"]!,
    vals["hour"]! % 24,
    vals["minute"]!,
    vals["second"]!,
  );
}

/** 给定 UTC 时刻，返回时区偏移（毫秒，当地 = UTC + offset）。 */
function offsetAt(timeZone: string, utcMs: number): number {
  return wallAt(timeZone, utcMs) - utcMs;
}

const PROBE_SPAN_MS = 36 * 60 * 60 * 1000;

/** 求墙钟时刻 wallMs 对应的所有有效 UTC 候选（通常 1 个，回拨时 2 个，不存在时 0 个）。 */
function resolveCandidates(timeZone: string, wallMs: number): number[] {
  const found = new Set<number>();
  const probes = [wallMs - PROBE_SPAN_MS, wallMs, wallMs + PROBE_SPAN_MS];
  for (const probe of probes) {
    let offset = offsetAt(timeZone, probe);
    for (let i = 0; i < 5; i++) {
      const candidate = wallMs - offset;
      const nextOffset = offsetAt(timeZone, candidate);
      if (nextOffset === offset) break;
      offset = nextOffset;
    }
    const candidate = wallMs - offset;
    if (wallAt(timeZone, candidate) === wallMs) found.add(candidate);
  }
  return [...found].sort((a, b) => a - b);
}

/** 在 (lo, hi) 内二分偏移跳变点，返回跳变前后的偏移差（after - before）。 */
function offsetDeltaAround(timeZone: string, wallMs: number): number {
  const before = offsetAt(timeZone, wallMs - PROBE_SPAN_MS);
  const after = offsetAt(timeZone, wallMs + PROBE_SPAN_MS);
  return after - before;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** UTC 时刻在时区下的当地日期 YYYY-MM-DD。 */
export function localDateOf(timeZone: string, utcMs: number): string {
  const parts = getFormatter(timeZone).formatToParts(new Date(utcMs));
  const vals: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== "literal") vals[p.type] = p.value;
  }
  return `${vals["year"]}-${vals["month"]}-${vals["day"]}`;
}

export function formatLocalDate(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, "0")}-${pad2(m)}-${pad2(d)}`;
}

/**
 * 将 IANA 时区下的当地日期+时刻换算为 UTC 时刻（epoch ms）。
 * - 时刻重复（时钟回拨）：取较早的 UTC 时刻。
 * - 时刻不存在（时钟前跳）：按实际偏移变化量向后平移；若平移后跨出原定日期
 *   （例如整日被跳过），返回 null。
 */
export function localToUtcMs(
  timeZone: string,
  date: string,
  time: string,
): number | null {
  const wallMs = parseWall(date, time);
  const candidates = resolveCandidates(timeZone, wallMs);
  if (candidates.length > 0) return candidates[0]!;

  const delta = offsetDeltaAround(timeZone, wallMs);
  if (delta <= 0) return null;
  const shiftedWall = wallMs + delta;
  const shifted = resolveCandidates(timeZone, shiftedWall);
  if (shifted.length === 0) return null;
  const result = shifted[0]!;
  if (localDateOf(timeZone, result) !== date) return null;
  return result;
}

/** 判断某当地日期在该时区下是否存在（整日被跳过时为 false）。 */
export function localDateExists(timeZone: string, date: string): boolean {
  for (const time of ["00:00", "06:00", "12:00", "18:00"]) {
    if (localToUtcMs(timeZone, date, time) !== null) return true;
  }
  return false;
}
