import { planBatch, type TreeState } from './batch.js';
import { Store } from './store.js';
import type { EditOp, InitNode, MapSnapshot, SubmitResult } from './types.js';

/**
 * 对外门面：初始化导图、读取导图及版本、提交批量编辑。
 * 单进程内所有调用均为同步执行，天然串行；
 * 版本校验在 SQLite 事务内完成，保证同版本竞争批次恰好一个成功。
 */
export class MindMapService {
  private store: Store;
  private cache = new Map<string, TreeState>();

  constructor(dbPath: string) {
    this.store = new Store(dbPath);
  }

  /** 初始化一张导图，返回初始版本 1。 */
  initMap(mapId: string, root: InitNode): number {
    const version = this.store.initMap(mapId, root);
    const state: TreeState = {
      rootId: root.id,
      parent: new Map<string, string | null>(),
      children: new Map<string, string[]>(),
    };
    const walk = (node: InitNode, parentId: string | null): void => {
      state.parent.set(node.id, parentId);
      const kids = node.children ?? [];
      state.children.set(
        node.id,
        kids.map((kid) => kid.id),
      );
      for (const kid of kids) {
        walk(kid, node.id);
      }
    };
    walk(root, null);
    this.cache.set(mapId, state);
    return version;
  }

  /** 读取一个完整的已提交版本：版本号与父子关系、顺序来自同一快照。 */
  readMap(mapId: string): MapSnapshot {
    const state = this.getState(mapId);
    const version = this.store.getVersion(mapId);
    if (version === null) {
      throw new Error(`map not found: ${mapId}`);
    }
    const parents: Record<string, string | null> = {};
    for (const [nodeId, parentId] of state.parent) {
      parents[nodeId] = parentId;
    }
    const children: Record<string, string[]> = {};
    for (const [nodeId, kids] of state.children) {
      children[nodeId] = [...kids];
    }
    return { mapId, version, parents, children, rootId: state.rootId };
  }

  /**
   * 提交一批编辑。仅当 baseVersion 仍是当前版本时才生效，
   * 成功后版本恰好 +1；任何一项不合法或版本过期都整批拒绝。
   */
  submitBatch(mapId: string, baseVersion: number, edits: EditOp[]): SubmitResult {
    const state = this.getState(mapId);
    // 版本过期直接整批拒绝，不做任何校验与修改
    if (this.store.getVersion(mapId) !== baseVersion) {
      // 缓存可能已被其他实例的提交弄脏，丢弃后下次从 SQLite 重载
      this.cache.delete(mapId);
      return { ok: false, reason: 'version_conflict' };
    }
    const plan = planBatch(state, edits);
    if (!plan.ok) {
      return { ok: false, reason: plan.reason };
    }
    const applied = this.store.applyBatch(mapId, baseVersion, {
      parentUpdates: plan.parentUpdates,
      childrenUpdates: [...plan.finalChildren].map(([parentId, kids]) => ({
        parentId,
        kids,
      })),
    });
    if (!applied.ok) {
      this.cache.delete(mapId);
      return { ok: false, reason: applied.reason };
    }
    for (const [parentId, finalList] of plan.finalChildren) {
      state.children.set(parentId, finalList);
    }
    for (const update of plan.parentUpdates) {
      state.parent.set(update.nodeId, update.parentId);
    }
    return { ok: true, version: applied.version };
  }

  close(): void {
    this.store.close();
  }

  private getState(mapId: string): TreeState {
    const cached = this.cache.get(mapId);
    if (cached) {
      return cached;
    }
    const rootId = this.store.getRootId(mapId);
    if (rootId === null) {
      throw new Error(`map not found: ${mapId}`);
    }
    const { nodes, children } = this.store.loadTree(mapId);
    const state: TreeState = {
      rootId,
      parent: new Map<string, string | null>(),
      children: new Map<string, string[]>(),
    };
    for (const row of nodes) {
      state.parent.set(row.nodeId, row.parentId);
    }
    for (const row of children) {
      state.children.set(row.parentId, row.kids);
    }
    this.cache.set(mapId, state);
    return state;
  }
}

export type { EditOp, InitNode, MapSnapshot, SubmitResult };
