import type { Batch, CheckResult, ImportSession } from "./types.js";
import { RuleStore } from "./store.js";
import { extractDomain, normalizeDomain } from "./normalize.js";

class ImportSessionImpl implements ImportSession {
  private open = true;

  constructor(
    private readonly store: RuleStore,
    readonly revision: number,
  ) {}

  get active(): boolean {
    return this.open;
  }

  addChunk(domains: Iterable<string>): void {
    this.assertOpen();
    const normalized: string[] = [];
    for (const domain of domains) {
      normalized.push(normalizeDomain(domain));
    }
    this.store.addToStaging(this.revision, normalized);
  }

  commit(): boolean {
    this.assertOpen();
    this.open = false;
    return this.store.commitStaging(this.revision);
  }

  abort(): void {
    this.assertOpen();
    this.open = false;
    this.store.discardStaging(this.revision);
  }

  private assertOpen(): void {
    if (!this.open) {
      throw new Error(`import for revision ${this.revision} is no longer active`);
    }
  }
}

class BatchImpl implements Batch {
  private open = true;

  constructor(
    private readonly store: RuleStore,
    readonly revision: number,
    private readonly token: number,
  ) {}

  get active(): boolean {
    return this.open;
  }

  checkLine(line: string): CheckResult {
    if (!this.open) {
      throw new Error("batch is no longer active");
    }
    const domain = normalizeDomain(extractDomain(line));
    const matchedRule = this.store.lookup(this.revision, domain);
    return {
      input: line,
      disposable: matchedRule !== null,
      matchedRule,
      revision: this.revision,
    };
  }

  close(): void {
    this.finish();
  }

  cancel(): void {
    this.finish();
  }

  private finish(): void {
    if (!this.open) {
      throw new Error("batch is no longer active");
    }
    this.open = false;
    this.store.releaseRevision(this.token);
  }
}

/** 一次性邮箱域名判定服务，由上层名单处理程序调用。 */
export class DisposableDomainService {
  protected readonly store: RuleStore;

  constructor(dbPath: string) {
    this.store = new RuleStore(dbPath);
  }

  /** 当前生效修订号（初始 0，对应空表）。 */
  currentRevision(): number {
    return this.store.currentRevision();
  }

  /** 开始一次整份替换导入；数据可分段到达，完整提交后才可能生效。 */
  beginImport(revision: number): ImportSession {
    this.store.beginStaging(revision);
    return new ImportSessionImpl(this.store, revision);
  }

  /** 受理一个名单批次：受理确认时即固定当前生效修订。 */
  acceptBatch(): Batch {
    const revision = this.store.currentRevision();
    const token = this.store.acquireRevision(revision);
    return new BatchImpl(this.store, revision, token);
  }

  close(): void {
    this.store.close();
  }
}
