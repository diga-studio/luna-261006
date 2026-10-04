/**
 * 时区工具：基于 Intl 的 UTC -> 本地换算与偏移变化检测。
 * 只依赖显式传入的 IANA 时区，不读取机器默认时区。
 */

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let fmt = formatterCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatterCache.set(timeZone, fmt);
  }
  return fmt;
}

/** UTC epoch ms 在指定时区下的偏移（毫秒，local = utc + offset） */
export function offsetMsAt(timeZone: string, utcMs: number): number {
  const parts = formatterFor(timeZone).formatToParts(utcMs);
  let year = 0, month = 0, day = 0, hour = 0, minute = 0, second = 0;
  for (const p of parts) {
    switch (p.type) {
      case "year": year = Number(p.value); break;
      case "month": month = Number(p.value); break;
      case "day": day = Number(p.value); break;
      case "hour": hour = Number(p.value); break;
      case "minute": minute = Number(p.value); break;
      case "second": second = Number(p.value); break;
    }
  }
  const localAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const utcWholeSeconds = Math.floor(utcMs / 1000) * 1000;
  return localAsUtc - utcWholeSeconds;
}

/** UTC epoch ms 换算为 (本地日序号, 当日分钟数, 分钟内毫秒余量) */
export function localParts(
  timeZone: string,
  utcMs: number,
): { dayNumber: number; minuteOfDay: number; msOfMinute: number } {
  const localMs = utcMs + offsetMsAt(timeZone, utcMs);
  const dayNumber = Math.floor(localMs / DAY_MS);
  const msOfDay = localMs - dayNumber * DAY_MS;
  return {
    dayNumber,
    minuteOfDay: Math.floor(msOfDay / MINUTE_MS),
    msOfMinute: msOfDay % MINUTE_MS,
  };
}

/**
 * 找出 [fromMs, toMs) 内所有偏移发生变化的 UTC 时刻（升序，精确到毫秒）。
 * 用于把时间轴切成常量偏移段。
 */
export function findOffsetTransitions(
  timeZone: string,
  fromMs: number,
  toMs: number,
): number[] {
  const transitions: number[] = [];
  if (fromMs >= toMs) return transitions;
  const STEP = DAY_MS; // 现代时区数据同一天内不会出现两次切换；发现一次后会在剩余区间继续找
  let cursor = fromMs;
  let cursorOffset = offsetMsAt(timeZone, cursor);
  while (cursor < toMs) {
    const next = Math.min(cursor + STEP, toMs);
    const nextOffset = offsetMsAt(timeZone, next);
    if (nextOffset !== cursorOffset) {
      // 在 (cursor, next] 内二分查找所有切换点
      let lo = cursor;
      const hi = next;
      let loOffset = cursorOffset;
      while (true) {
        // 找 (lo, hi] 中第一个偏移不等于 loOffset 的时刻
        let a = lo, b = hi;
        while (b - a > 1) {
          const mid = a + Math.floor((b - a) / 2);
          if (offsetMsAt(timeZone, mid) === loOffset) a = mid; else b = mid;
        }
        transitions.push(b);
        if (b >= hi) break;
        lo = b;
        loOffset = offsetMsAt(timeZone, lo);
        if (offsetMsAt(timeZone, hi) === loOffset) break; // 剩余区间无更多切换
      }
      cursorOffset = offsetMsAt(timeZone, next);
    }
    cursor = next;
  }
  return transitions;
}
