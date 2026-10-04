import { detectTemporalCycle } from "./cycle";
import {
  addVersion,
  buildEdgeIntervals,
  createTimeline,
  removeVersion,
  versionAt,
  type VersionTimeline,
} from "./timeline";
import type { BomRevision, PublishResult } from "./types";

/**
 * 进程内 BOM 版本发布组件。
 * 维护每个装配的版本时间表；每次发布按批次整体校验：
 * 若批次加入后的最终时间表在任一天成环，则拒绝整个批次并保证原有时间表不变。
 */
export class BomService {
  private readonly timelines = new Map<string, VersionTimeline>();

  publishBatch(revisions: readonly BomRevision[]): PublishResult {
    if (revisions.length === 0) return { ok: true };

    // 记录批次前不存在的装配，便于拒绝时完整回滚。
    const created = new Set<string>();
    for (const revision of revisions) {
      if (!this.timelines.has(revision.assemblyId)) {
        created.add(revision.assemblyId);
      }
    }

    for (const revision of revisions) {
      let timeline = this.timelines.get(revision.assemblyId);
      if (timeline === undefined) {
        timeline = createTimeline();
        this.timelines.set(revision.assemblyId, timeline);
      }
      addVersion(timeline, revision.startDay, revision.components);
    }

    const witness = detectTemporalCycle(buildEdgeIntervals(this.timelines));
    if (witness === null) return { ok: true };

    // 回滚：逐个移除本批次加入的版本；批次前没有版本的装配整体移除。
    for (const revision of revisions) {
      const timeline = this.timelines.get(revision.assemblyId);
      if (timeline === undefined) continue;
      if (created.has(revision.assemblyId)) this.timelines.delete(revision.assemblyId);
      else removeVersion(timeline, revision.startDay);
    }
    return { ok: false, day: witness.day, cycle: witness.path };
  }

  bomAt(assemblyId: string, day: number): BomRevision | null {
    const timeline = this.timelines.get(assemblyId);
    if (timeline === undefined) return null;
    const effective = versionAt(timeline, day);
    if (effective === null) return null;
    return { assemblyId, startDay: effective.startDay, components: effective.components.slice() };
  }
}
