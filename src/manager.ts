import * as path from "node:path";
import { Database } from "./db";
import { ActiveRecord, PackageStore } from "./store";
import {
  CrashHook,
  GatewayManagerOptions,
  GatewayStatus,
  InferenceReport,
  PublishResult,
  ReportResult,
} from "./types";

/** 连续失败触发回退的次数与毫秒时间窗（首尾时间差不超过该值即触发）。 */
export const ROLLBACK_FAIL_COUNT = 3;
export const ROLLBACK_WINDOW_MS = 300000;

interface StoredPublishResult {
  releaseId: number;
  generation: number;
}

interface StoredReportResult {
  applied: boolean;
  rolledBack: boolean;
}

/**
 * 网关本地部署管理器。每个实例管理一个网关，所有调用串行执行。
 *
 * 持久化真源在 SQLite；active.json 是由真源派生的生效记录，
 * 恢复时以 SQLite 为准重写，保证只表示停止或指向完整可读的同一发布包。
 */
export class GatewayManager {
  private chain: Promise<unknown> = Promise.resolve();
  private closed = false;

  private constructor(
    private readonly db: Database,
    private readonly store: PackageStore,
    private readonly crashHook: CrashHook
  ) {}

  /** 打开（并恢复）指定工作目录下的网关管理实例。 */
  static async open(baseDir: string, options: GatewayManagerOptions = {}): Promise<GatewayManager> {
    const store = new PackageStore(baseDir);
    const db = new Database(path.join(baseDir, "edgeforge.db"));
    const manager = new GatewayManager(db, store, options.crashHook ?? (() => {}));
    manager.recoverSync();
    return manager;
  }

  /** 发布整包。sourceDir 须含 pipeline.json 与 model.bin（≤100MB），返回后即可删除。 */
  publish(requestId: string, sourceDir: string): Promise<PublishResult> {
    return this.enqueue(() => this.publishSync(requestId, sourceDir));
  }

  /** 报告一次推理结果；仅当前运行代次的报告会被处理。 */
  reportInference(requestId: string, report: InferenceReport): Promise<ReportResult> {
    return this.enqueue(() => this.reportSync(requestId, report));
  }

  /** 恢复并查看当前状态。 */
  recover(): Promise<GatewayStatus> {
    return this.enqueue(() => {
      this.recoverSync();
      return this.getStatus();
    });
  }

  /** 查看当前状态（无副作用，不新增发布记录或运行代次）。 */
  getStatus(): GatewayStatus {
    const state = this.db.getRunState();
    return {
      running: state.currentReleaseId !== null,
      generation: state.generation,
      currentReleaseId: state.currentReleaseId,
      activeDir:
        state.currentReleaseId === null ? null : this.store.releaseDir(state.currentReleaseId),
      releases: this.db.listReleases(),
    };
  }

  close(): void {
    this.closed = true;
    this.db.close();
  }

  private enqueue<T>(op: () => T): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error("GatewayManager is closed"));
    }
    const run = this.chain.then(op);
    this.chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private publishSync(requestId: string, sourceDir: string): PublishResult {
    const existing = this.db.getRequest(requestId);
    if (existing) {
      const stored = JSON.parse(existing.result) as StoredPublishResult;
      return { requestId, ...stored, duplicated: true };
    }

    this.store.stagePackage(sourceDir);
    this.crashHook("publish.afterStage");

    const releaseId = this.db.nextReleaseId();
    this.store.commitStaged(releaseId);
    this.crashHook("publish.afterCommitDir");

    const result = this.db.transaction(() => {
      const state = this.db.getRunState();
      const generation = state.generation + 1;
      this.db.insertRelease(releaseId, Date.now());
      this.db.setRunState({ generation, currentReleaseId: releaseId });
      this.db.setFailEvidence([]);
      const stored: StoredPublishResult = { releaseId, generation };
      this.db.recordRequest(requestId, "publish", JSON.stringify(stored));
      return { requestId, ...stored, duplicated: false };
    });
    this.crashHook("publish.afterDbCommit");

    this.store.writeActive({
      state: "running",
      generation: result.generation,
      releaseId,
      dir: this.store.releaseDir(releaseId),
    });
    this.crashHook("publish.afterActiveWrite");
    return result;
  }

  private reportSync(requestId: string, report: InferenceReport): ReportResult {
    const existing = this.db.getRequest(requestId);
    if (existing) {
      const stored = JSON.parse(existing.result) as StoredReportResult;
      return { requestId, ...stored, duplicated: true };
    }

    let switchTo: ActiveRecord | null = null;
    const result = this.db.transaction(() => {
      const state = this.db.getRunState();
      let applied = false;
      let rolledBack = false;

      if (state.currentReleaseId !== null && report.generation === state.generation) {
        applied = true;
        if (report.success) {
          this.db.setFailEvidence([]);
        } else {
          const evidence = [...this.db.getFailEvidence(), report.timestampMs].slice(
            -ROLLBACK_FAIL_COUNT
          );
          this.db.setFailEvidence(evidence);
          if (
            evidence.length === ROLLBACK_FAIL_COUNT &&
            evidence[evidence.length - 1] - evidence[0] <= ROLLBACK_WINDOW_MS
          ) {
            rolledBack = true;
            const failedId = state.currentReleaseId;
            this.db.eliminateRelease(failedId);
            const candidate = this.db.findRollbackCandidate(failedId);
            const generation = state.generation + 1;
            this.db.setRunState({ generation, currentReleaseId: candidate });
            this.db.setFailEvidence([]);
            switchTo =
              candidate === null
                ? { state: "stopped", generation }
                : {
                    state: "running",
                    generation,
                    releaseId: candidate,
                    dir: this.store.releaseDir(candidate),
                  };
          }
        }
      }

      const stored: StoredReportResult = { applied, rolledBack };
      this.db.recordRequest(requestId, "report", JSON.stringify(stored));
      return { requestId, ...stored, duplicated: false };
    });
    this.crashHook("report.afterDbCommit");

    if (switchTo !== null) {
      this.store.writeActive(switchTo);
      this.crashHook("report.afterActiveWrite");
    }
    return result;
  }

  /**
   * 恢复：清理半次发布（staging 与无发布记录的孤儿目录），
   * 并以 SQLite 真源重写生效记录。不新增发布记录或运行代次。
   */
  private recoverSync(): void {
    this.store.cleanupStaging();

    const known = new Set(this.db.listReleases().map((r) => r.id));
    for (const id of this.store.listReleaseDirs()) {
      if (!known.has(id)) {
        this.store.removeReleaseDir(id);
      }
    }

    const state = this.db.getRunState();
    const desired: ActiveRecord =
      state.currentReleaseId === null
        ? { state: "stopped", generation: state.generation }
        : {
            state: "running",
            generation: state.generation,
            releaseId: state.currentReleaseId,
            dir: this.store.releaseDir(state.currentReleaseId),
          };
    const current = this.store.readActive();
    if (JSON.stringify(current) !== JSON.stringify(desired)) {
      this.store.writeActive(desired);
    }
  }
}
