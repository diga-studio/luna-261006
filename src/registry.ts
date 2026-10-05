import { migrateAnnotations } from './migration.js';
import type {
  AnnotationInput,
  MigrationPreview,
  SegmentInput,
} from './types.js';
import { normalizeAnnotation, Version, type NormalizedAnnotation } from './version.js';

/**
 * 迁移库入口：登记剪辑版本及其批注，生成版本间迁移预览。
 * 全部数据仅保存在进程内存中，单进程顺序调用。
 */
export class MigrationRegistry {
  private readonly versions = new Map<string, Version>();
  private readonly annotations = new Map<string, NormalizedAnnotation[]>();
  private readonly annotationIds = new Map<string, Set<string>>();

  /** 登记一个剪辑版本；versionId 重复时抛错。 */
  registerVersion(versionId: string, segments: readonly SegmentInput[]): void {
    if (this.versions.has(versionId)) {
      throw new Error(`version already registered: ${versionId}`);
    }
    this.versions.set(versionId, new Version(versionId, segments));
    this.annotations.set(versionId, []);
    this.annotationIds.set(versionId, new Set());
  }

  /** 为已登记的版本登记批注；可多次调用，批注 id 在版本内唯一。 */
  registerAnnotations(versionId: string, annotations: readonly AnnotationInput[]): void {
    const version = this.versions.get(versionId);
    if (version === undefined) {
      throw new Error(`version not registered: ${versionId}`);
    }
    const stored = this.annotations.get(versionId)!;
    const ids = this.annotationIds.get(versionId)!;
    for (const input of annotations) {
      if (ids.has(input.id)) {
        throw new Error(`duplicate annotation id in version ${versionId}: ${input.id}`);
      }
      ids.add(input.id);
      stored.push(normalizeAnnotation(input, version.totalFrames));
    }
  }

  /**
   * 生成 fromVersionId 到 toVersionId 的迁移预览。
   * 不修改旧批注；每条旧批注都有独立结果（含空结果）。
   */
  migrate(fromVersionId: string, toVersionId: string): MigrationPreview {
    const fromVersion = this.versions.get(fromVersionId);
    if (fromVersion === undefined) {
      throw new Error(`version not registered: ${fromVersionId}`);
    }
    const toVersion = this.versions.get(toVersionId);
    if (toVersion === undefined) {
      throw new Error(`version not registered: ${toVersionId}`);
    }
    const annotations = this.annotations.get(fromVersionId)!;
    return {
      fromVersionId,
      toVersionId,
      results: migrateAnnotations(fromVersion, toVersion, annotations),
    };
  }
}
