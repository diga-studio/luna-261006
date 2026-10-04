import { normalizeDomain } from "./normalize";
import { DomainStore } from "./store";

/** 单行检查结果，逐行交给调用方。 */
export interface CheckResult {
  /** 原始输入行。 */
  line: string;
  /** 归一化后的域名。 */
  domain: string;
  disposable: boolean;
  /** 命中的规则（归一化后的域名，标签最多者）；未命中为 null。 */
  matchedRule: string | null;
  /** 本批次受理时固定的修订号。 */
  revision: number;
}

export interface Batch {
  /** 本批次受理时固定的修订号。 */
  readonly revision: number;
  /** 检查一行邮箱；批次结束或取消后调用会抛错，不再交付结果。 */
  check(email: string): CheckResult;
  /** 正常结束批次，释放对旧修订的占用。 */
  finish(): void;
  /** 取消批次：已交付结果不撤回，之后不再交付。 */
  cancel(): void;
}

type BatchState = "active" | "finished" | "cancelled";

class BatchImpl implements Batch {
  readonly revision: number;
  private state: BatchState = "active";
  private readonly rules: ReadonlySet<string>;
  private readonly onClose: (revision: number) => void;

  constructor(revision: number, rules: ReadonlySet<string>, onClose: (revision: number) => void) {
    this.revision = revision;
    this.rules = rules;
    this.onClose = onClose;
  }

  check(email: string): CheckResult {
    if (this.state !== "active") {
      throw new Error(`batch is ${this.state}; no more results are delivered`);
    }
    const at = email.lastIndexOf("@");
    const rawDomain = at === -1 ? email : email.slice(at + 1);
    const domain = normalizeDomain(rawDomain);
    const matchedRule = longestMatch(domain, this.rules);
    return {
      line: email,
      domain,
      disposable: matchedRule !== null,
      matchedRule,
      revision: this.revision,
    };
  }

  finish(): void {
    this.close("finished");
  }

  cancel(): void {
    this.close("cancelled");
  }

  private close(next: BatchState): void {
    if (this.state !== "active") {
      throw new Error(`batch is already ${this.state}`);
    }
    this.state = next;
    this.onClose(this.revision);
  }
}

/** 在完整标签边界上匹配自身及所有子域；命中多条时取标签最多者。 */
function longestMatch(domain: string, rules: ReadonlySet<string>): string | null {
  let candidate = domain;
  for (;;) {
    if (rules.has(candidate)) {
      return candidate;
    }
    const dot = candidate.indexOf(".");
    if (dot === -1) {
      return null;
    }
    candidate = candidate.slice(dot + 1);
  }
}

/**
 * 一次性邮箱域名判定服务。
 * 批次在受理确认时即固定当时生效的修订，整批不混用修订；
 * 批次结束或取消后释放占用，无人使用的失效修订被回收。
 */
export class DisposableDomainService {
  private readonly store: DomainStore;
  /** 修订号 -> 正在使用该修订的活跃批次数。 */
  private readonly pins = new Map<number, number>();

  constructor(dbPath: string) {
    this.store = new DomainStore(dbPath);
  }

  /** 受理一个批次：立即固定当前生效修订，并把该修订的完整规则快照交给批次。 */
  beginBatch(): Batch {
    const revision = this.store.currentRevision();
    const rules = new Set(this.store.loadDomains(revision));
    this.pins.set(revision, (this.pins.get(revision) ?? 0) + 1);
    return new BatchImpl(revision, rules, (rev) => this.release(rev));
  }

  /** 开始整份替换导入；revision 为调用方提供的唯一正整数。 */
  beginImport(revision: number): void {
    this.store.beginImport(revision);
  }

  /** 追加一段域名；条目按与邮箱域名相同的规则归一化。 */
  importChunk(revision: number, domains: string[]): void {
    this.store.importChunk(revision, domains.map(normalizeDomain));
  }

  /** 完成导入：只有完整成功的修订才生效；之后回收无人使用的失效修订。 */
  commitImport(revision: number): void {
    this.store.commitImport(revision);
    this.collectGarbage();
  }

  /** 中止导入，丢弃未完成的修订数据。 */
  abortImport(revision: number): void {
    this.store.abortImport(revision);
  }

  currentRevision(): number {
    return this.store.currentRevision();
  }

  close(): void {
    this.store.close();
  }

  private release(revision: number): void {
    const count = this.pins.get(revision);
    if (count === undefined) {
      throw new Error(`revision ${revision} is not pinned`);
    }
    if (count === 1) {
      this.pins.delete(revision);
    } else {
      this.pins.set(revision, count - 1);
    }
    this.collectGarbage();
  }

  /** 回收已失效且无人使用的修订；仍被批次使用的修订保持可读。 */
  private collectGarbage(): void {
    this.store.gcRevisions(new Set(this.pins.keys()));
  }
}
