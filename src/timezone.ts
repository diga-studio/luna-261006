const HOUR_MS = 3_600_000;

/**
 * 时区工具：基于 Intl 的 IANA 时区换算，精确到毫秒，
 * 不依赖机器默认时区与当前时间。
 */
export class TimeZone {
  private readonly formatter: Intl.DateTimeFormat;

  constructor(public readonly name: string) {
    this.formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: name,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    // 校验时区名合法性
    this.offsetAt(0);
  }

  /** 给定 UTC 毫秒，返回本地历法毫秒（本地年月日时分秒毫秒按 UTC 解读的值）。 */
  toLocalCivilMs(utcMs: number): number {
    const ms = utcMs - Math.floor(utcMs / 1000) * 1000;
    const parts = this.formatter.formatToParts(utcMs - ms);
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
    return Date.UTC(year, month - 1, day, hour, minute, second) + ms;
  }

  /** 给定 UTC 毫秒，返回该时区的偏移（local - utc），单位毫秒。 */
  offsetAt(utcMs: number): number {
    return this.toLocalCivilMs(utcMs) - utcMs;
  }

  /**
   * 给定本地历法毫秒，返回所有映射到它的 UTC 毫秒时刻（升序）。
   * 夏令时跳过的本地时间返回空数组；重复时段返回两个时刻。
   */
  localToUtc(localCivilMs: number): number[] {
    // 先取近似偏移估计真实 UTC 位置，再在其 ±3 小时窗口内采样所有可能偏移。
    // 现代时区单次跳变不超过 2 小时，该窗口足以覆盖跳变两侧。
    const approx = this.offsetAt(localCivilMs);
    const guess = localCivilMs - approx;
    const offsets = new Set<number>();
    for (const delta of [-3 * HOUR_MS, 0, 3 * HOUR_MS]) {
      offsets.add(this.offsetAt(guess + delta));
    }
    const result: number[] = [];
    for (const off of offsets) {
      const candidate = localCivilMs - off;
      if (this.offsetAt(candidate) === off) result.push(candidate);
    }
    result.sort((a, b) => a - b);
    return result;
  }

  /** 返回 [fromUtc, toUtc] 内所有偏移发生跳变的 UTC 时刻（升序，精确到毫秒）。 */
  transitionsBetween(fromUtc: number, toUtc: number): number[] {
    const result: number[] = [];
    const step = 6 * HOUR_MS;
    let prevT = fromUtc;
    let prevOff = this.offsetAt(fromUtc);
    let t = Math.min(fromUtc + step, toUtc);
    for (;;) {
      const off = this.offsetAt(t);
      if (off !== prevOff) {
        result.push(this.findTransition(prevT, t, prevOff));
        prevOff = off;
      }
      if (t >= toUtc) break;
      prevT = t;
      t = Math.min(t + step, toUtc);
    }
    return result;
  }

  /** 在 (a, b] 内二分偏移跳变点：返回最小的 t 使 offsetAt(t) !== offBefore。 */
  private findTransition(a: number, b: number, offBefore: number): number {
    while (b - a > 1) {
      const m = a + Math.floor((b - a) / 2);
      if (this.offsetAt(m) === offBefore) a = m;
      else b = m;
    }
    return b;
  }
}
