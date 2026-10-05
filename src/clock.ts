/** 可注入时钟，返回当前时刻 epoch 毫秒。 */
export interface Clock {
  nowMs(): number;
}

export class SystemClock implements Clock {
  nowMs(): number {
    return Date.now();
  }
}

/** 测试用手动时钟。 */
export class ManualClock implements Clock {
  private current: number;
  constructor(startMs: number) {
    this.current = startMs;
  }
  nowMs(): number {
    return this.current;
  }
  set(ms: number): void {
    this.current = ms;
  }
  advance(ms: number): void {
    this.current += ms;
  }
}
