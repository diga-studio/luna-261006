import type { Annotation, ClipSegment, MigrationResult } from './types.js';
import { TimelineIndex } from './timeline.js';
import { SourceIndex } from './sourceIndex.js';
import { migrateAnnotations, normalizeAnnotationRange } from './migrate.js';

/**
 * 批注迁移预览库的主入口。由上层审片工具调用；
 * 剪辑清单与批注仅保存在进程内存中，不处理视频解码。
 */
export class MigrationPreviewer {
  private readonly versions = new Map<string, TimelineIndex>();
  private readonly annotations = new Map<string, Annotation[]>();
  private readonly annotationIds = new Map<string, Set<string>>();
  private readonly sourceIndexes = new Map<string, SourceIndex>();

  /** 登记一个剪辑版本及其剪辑清单。同一版本标识只能登记一次。 */
  registerVersion(versionId: string, segments: readonly ClipSegment[]): void {
    if (typeof versionId !== 'string' || versionId.length === 0) {
      throw new Error('versionId must be a non-empty string');
    }
    if (this.versions.has(versionId)) {
      throw new Error(`version already registered: ${versionId}`);
    }
    this.versions.set(versionId, new TimelineIndex(segments));
  }

  /** 登记某个版本的批注（可多次调用追加）。批注标识在同一版本内必须唯一。 */
  registerAnnotations(versionId: string, annotations: readonly Annotation[]): void {
    const timeline = this.versions.get(versionId);
    if (timeline === undefined) {
      throw new Error(`unknown version: ${versionId}`);
    }
    let idSet = this.annotationIds.get(versionId);
    let list = this.annotations.get(versionId);
    if (idSet === undefined || list === undefined) {
      idSet = new Set<string>();
      list = [];
      this.annotationIds.set(versionId, idSet);
      this.annotations.set(versionId, list);
    }
    for (const annotation of annotations) {
      if (typeof annotation.id !== 'string' || annotation.id.length === 0) {
        throw new Error('annotation id must be a non-empty string');
      }
      if (idSet.has(annotation.id)) {
        throw new Error(`duplicate annotation id in version ${versionId}: ${annotation.id}`);
      }
      const [, end] = normalizeAnnotationRange(annotation);
      if (end > timeline.totalFrames) {
        throw new Error(
          `annotation ${annotation.id}: range exceeds timeline length ${timeline.totalFrames}`,
        );
      }
      idSet.add(annotation.id);
      list.push(annotation);
    }
  }

  /**
   * 生成 fromVersionId 到 toVersionId 的迁移预览。
   * 不修改旧批注；每条旧批注都有独立结果（包括没有落点的空结果）。
   */
  createPreview(fromVersionId: string, toVersionId: string): MigrationResult[] {
    const oldTimeline = this.versions.get(fromVersionId);
    if (oldTimeline === undefined) {
      throw new Error(`unknown version: ${fromVersionId}`);
    }
    const newTimeline = this.versions.get(toVersionId);
    if (newTimeline === undefined) {
      throw new Error(`unknown version: ${toVersionId}`);
    }
    let sourceIndex = this.sourceIndexes.get(toVersionId);
    if (sourceIndex === undefined) {
      sourceIndex = new SourceIndex(newTimeline.segments);
      this.sourceIndexes.set(toVersionId, sourceIndex);
    }
    const annotations = this.annotations.get(fromVersionId) ?? [];
    return migrateAnnotations(oldTimeline, sourceIndex, annotations);
  }
}
