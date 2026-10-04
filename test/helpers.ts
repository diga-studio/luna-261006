import type { PageReader, PageResult } from '../src/index.js';

/**
 * 完成顺序完全由测试控制的读取器：
 * read 调用立即登记并挂起，测试通过 resolve(url) 决定何时返回。
 */
export class ControlledReader {
  readonly reader: PageReader;
  private readonly pages: ReadonlyMap<string, PageResult>;
  private readonly counts = new Map<string, number>();
  private readonly waiting = new Map<string, Array<(r: PageResult) => void>>();

  constructor(pages: Record<string, PageResult>) {
    this.pages = new Map(Object.entries(pages));
    this.reader = (url: string) => {
      this.counts.set(url, (this.counts.get(url) ?? 0) + 1);
      return new Promise<PageResult>((resolve) => {
        const list = this.waiting.get(url);
        if (list === undefined) {
          this.waiting.set(url, [resolve]);
        } else {
          list.push(resolve);
        }
      });
    };
  }

  /** 当前已发起但尚未完成的读取地址。 */
  pending(): string[] {
    return [...this.waiting.keys()].filter((k) => (this.waiting.get(k)?.length ?? 0) > 0);
  }

  /** 让 url 的挂起读取按预置内容返回。 */
  resolve(url: string): void {
    const list = this.waiting.get(url);
    const result = this.pages.get(url);
    if (list === undefined || list.length === 0) {
      throw new Error(`no pending read for ${url}`);
    }
    if (result === undefined) {
      throw new Error(`no page registered for ${url}`);
    }
    for (const resolve of list) resolve(result);
    list.length = 0;
  }

  count(url: string): number {
    return this.counts.get(url) ?? 0;
  }

  totalReads(): number {
    let total = 0;
    for (const n of this.counts.values()) total += n;
    return total;
  }
}

/** 等一个宏任务，让已 resolve 的读取完成传播。 */
export function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export function links(...urls: string[]): PageResult {
  return { kind: 'links', links: urls };
}

export function redirect(target: string): PageResult {
  return { kind: 'redirect', target };
}
