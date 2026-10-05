/** 可重复使用的闸门：release 前 wait 挂起，release 后 wait 立即通过。 */
export class Gate {
  private open = false;
  private waiters: Array<() => void> = [];

  wait(): Promise<void> {
    if (this.open) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    this.open = true;
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }
}

/** 手动触发的信号：测试等待“重算已到达暂停点”。 */
export class Signal {
  public readonly promise: Promise<void>;
  private resolveFn!: () => void;

  constructor() {
    this.promise = new Promise((resolve) => {
      this.resolveFn = resolve;
    });
  }

  fire(): void {
    this.resolveFn();
  }
}
