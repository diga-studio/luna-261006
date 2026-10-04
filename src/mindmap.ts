import { MapNotFoundError, VersionConflictError } from './errors.js';
import { MapStore } from './store.js';
import { applyBatch } from './tree.js';
import type {
  BatchEdit,
  CommitResult,
  MindMapNodeInput,
  MindMapNodeView,
  MindMapSnapshot,
  TreeState,
} from './types.js';

interface CachedMap {
  version: number;
  state: TreeState;
}

/**
 * 思维导图批量编辑库入口，由上层直接调用。
 * 导图数据持久化到 SQLite；内存缓存只保存已提交版本的状态，
 * 提交全部经由单个 SQLite 事务完成，失败不留任何修改。
 */
export class MindMapLibrary {
  private readonly store: MapStore;
  private readonly cache = new Map<string, CachedMap>();

  constructor(dbPath: string) {
    this.store = new MapStore(dbPath);
  }

  /** 初始化导图，输入保证是一棵合法有序树。返回初始版本。 */
  async initMap(mapId: string, root: MindMapNodeInput): Promise<CommitResult> {
    const created = this.store.createMap(mapId, root);
    this.cache.set(mapId, created);
    return { version: created.version };
  }

  /** 读取导图及版本：始终返回一个完整的已提交版本。 */
  async getMap(mapId: string): Promise<MindMapSnapshot> {
    const { version, state } = this.current(mapId);
    return { mapId, version, root: toView(state) };
  }

  /**
   * 提交批量编辑：整批同时表达目标状态，原子生效或整批拒绝。
   * 仅当 baseVersion 仍是当前版本时才允许提交，成功后版本恰好 +1。
   */
  async submitBatch(mapId: string, batch: BatchEdit): Promise<CommitResult> {
    const { version, state } = this.current(mapId);
    if (batch.baseVersion !== version) {
      throw new VersionConflictError(batch.baseVersion, version);
    }
    const next = applyBatch(state, batch.edits);
    const nextVersion = this.store.commitMap(mapId, batch.baseVersion, state, next, batch.edits);
    this.cache.set(mapId, { version: nextVersion, state: next });
    return { version: nextVersion };
  }

  async close(): Promise<void> {
    this.store.close();
  }

  /** 当前已提交状态：版本未变时命中内存缓存，否则从 SQLite 重载。 */
  private current(mapId: string): CachedMap {
    const version = this.store.loadVersion(mapId);
    if (version === null) {
      throw new MapNotFoundError(mapId);
    }
    const cached = this.cache.get(mapId);
    if (cached !== undefined && cached.version === version) {
      return cached;
    }
    const loaded = this.store.loadMap(mapId);
    if (loaded === null) {
      throw new MapNotFoundError(mapId);
    }
    this.cache.set(mapId, loaded);
    return loaded;
  }
}

/** 由扁平状态重建有序树视图。 */
function toView(state: TreeState): MindMapNodeView {
  const views = new Map<string, MindMapNodeView>();
  for (const id of state.children.keys()) {
    views.set(id, { id, children: [] });
  }
  for (const [parentId, kids] of state.children) {
    const parentView = views.get(parentId)!;
    for (const kid of kids) {
      parentView.children.push(views.get(kid)!);
    }
  }
  return views.get(state.rootId)!;
}
