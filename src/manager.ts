import * as fs from "node:fs";
import * as path from "node:path";
import { crashIfRequested } from "./crash";
import { Database } from "./db";
import { PackageStore } from "./packages";
import type {
  GatewayStatus,
  PublishRequest,
  PublishResult,
  ReportRequest,
  ReportResult,
  RollbackInfo,
} from "./types";

const ROLLBACK_WINDOW_MS = 300000;
const ROLLBACK_FAILURE_COUNT = 3;

/**
 * EdgeForge 网关本地部署管理器。每个实例管理一个网关，调用串行执行。
 * SQLite 事务是业务效果的提交点；生效记录文件在提交后切换，
 * 恢复时以 SQLite 状态为准重新对齐生效记录。
 */
export class GatewayManager {
  private readonly db: Database;
  private readonly store: PackageStore;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new Database(path.join(dataDir, "edgeforge.db"));
    this.store = new PackageStore(dataDir);
    this.reconcile();
  }

  publish(request: PublishRequest): PublishResult {
    const existing = this.db.findRequest(request.requestId);
    if (existing !== null) {
      return { ...(JSON.parse(existing.resultJson) as PublishResult), duplicate: true };
    }

    const releaseId = this.db.nextReleaseId();
    this.store.storePackage(request.sourceDir, releaseId);
    crashIfRequested("publish.afterPackageStore");

    const generation = this.db.getState().generation + 1;
    const result: PublishResult = { requestId: request.requestId, duplicate: false, releaseId, generation };
    this.db.commitPublish(request.requestId, Date.now(), JSON.stringify(result));
    crashIfRequested("publish.afterDbCommit");

    this.store.switchPointer({ generation, releaseId });
    crashIfRequested("publish.afterPointerSwitch");
    return result;
  }

  reportInference(request: ReportRequest): ReportResult {
    const existing = this.db.findRequest(request.requestId);
    if (existing !== null) {
      return { ...(JSON.parse(existing.resultJson) as ReportResult), duplicate: true };
    }

    const state = this.db.getState();
    const accepted = state.currentReleaseId !== null && request.generation === state.generation;

    let rollback: RollbackInfo | null = null;
    if (accepted) {
      const recent = this.db.recentReports(state.generation, ROLLBACK_FAILURE_COUNT - 1);
      const streak = [request, ...recent].slice(0, ROLLBACK_FAILURE_COUNT);
      const allFailed =
        streak.length === ROLLBACK_FAILURE_COUNT && streak.every((entry) => !entry.success);
      if (allFailed) {
        const span = streak[0].timestamp - streak[streak.length - 1].timestamp;
        if (span <= ROLLBACK_WINDOW_MS) {
          const eliminatedReleaseId = state.currentReleaseId as number;
          const targetReleaseId = this.db.findRollbackTarget(eliminatedReleaseId);
          rollback = {
            eliminatedReleaseId,
            targetReleaseId,
            generation: state.generation + 1,
          };
        }
      }
    }

    const result: ReportResult = {
      requestId: request.requestId,
      duplicate: false,
      accepted,
      rollback,
    };
    this.db.commitReport(
      request.requestId,
      accepted ? request : null,
      rollback,
      JSON.stringify(result),
    );
    if (rollback !== null) {
      crashIfRequested("rollback.afterDbCommit");
      this.store.switchPointer({
        generation: rollback.generation,
        releaseId: rollback.targetReleaseId,
      });
      crashIfRequested("rollback.afterPointerSwitch");
    }
    return result;
  }

  recover(): GatewayStatus {
    this.reconcile();
    return this.getStatus();
  }

  getStatus(): GatewayStatus {
    const state = this.db.getState();
    return {
      generation: state.generation,
      currentReleaseId: state.currentReleaseId,
      running: state.currentReleaseId !== null,
      releases: this.db.listReleases().map((release) => ({
        releaseId: release.id,
        eliminated: release.eliminated,
        createdAt: release.createdAt,
      })),
    };
  }

  close(): void {
    this.db.close();
  }

  /**
   * 恢复一致性：清理崩溃残留的暂存文件，并把生效记录对齐到
   * SQLite 中已提交的状态。不产生新的发布记录或运行代次。
   */
  private reconcile(): void {
    this.store.cleanupStaging();
    this.store.pruneUnknown(new Set(this.db.listReleases().map((release) => release.id)));
    const state = this.db.getState();
    const pointer = this.store.readPointer();
    if (pointer.generation !== state.generation || pointer.releaseId !== state.currentReleaseId) {
      this.store.switchPointer({ generation: state.generation, releaseId: state.currentReleaseId });
    }
  }
}
