import { DatabaseSync } from 'node:sqlite';
import type { InitNode } from './types.js';

export interface NodeRow {
  nodeId: string;
  parentId: string | null;
}

export interface ChildrenRow {
  parentId: string;
  kids: string[];
}

/** 一次成功批量编辑需要落盘的变更。 */
export interface BatchChanges {
  /** 父指针发生变化的节点。 */
  parentUpdates: { nodeId: string; parentId: string }[];
  /** 孩子列表发生变化的父节点及其最终孩子顺序。 */
  childrenUpdates: ChildrenRow[];
}

export type ApplyResult =
  | { ok: true; version: number }
  | { ok: false; reason: 'version_conflict' };

/**
 * SQLite 持久化层。
 * 表结构：
 *   maps(id, version, root_id)
 *   nodes(map_id, node_id, parent_id)              -- 每个节点一行
 *   children(map_id, parent_id, kids_json)         -- 每个父节点一行，孩子顺序存 JSON
 * 大孩子列表重排只重写对应父节点的一行，避免整列表逐行更新。
 */
export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS maps (
        id TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        root_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS nodes (
        map_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        parent_id TEXT,
        PRIMARY KEY (map_id, node_id)
      );
      CREATE TABLE IF NOT EXISTS children (
        map_id TEXT NOT NULL,
        parent_id TEXT NOT NULL,
        kids_json TEXT NOT NULL,
        PRIMARY KEY (map_id, parent_id)
      );
    `);
  }

  /** 初始化一张导图，初始版本为 1。已存在同名图时抛错。 */
  initMap(mapId: string, root: InitNode): number {
    const existing = this.db
      .prepare('SELECT version FROM maps WHERE id = ?')
      .get(mapId) as { version: number } | undefined;
    if (existing) {
      throw new Error(`map already exists: ${mapId}`);
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare('INSERT INTO maps (id, version, root_id) VALUES (?, 1, ?)')
        .run(mapId, root.id);
      const insertNode = this.db.prepare(
        'INSERT INTO nodes (map_id, node_id, parent_id) VALUES (?, ?, ?)',
      );
      const insertChildren = this.db.prepare(
        'INSERT INTO children (map_id, parent_id, kids_json) VALUES (?, ?, ?)',
      );
      const walk = (node: InitNode, parentId: string | null): void => {
        insertNode.run(mapId, node.id, parentId);
        const kids = node.children ?? [];
        insertChildren.run(
          mapId,
          node.id,
          JSON.stringify(kids.map((kid) => kid.id)),
        );
        for (const kid of kids) {
          walk(kid, node.id);
        }
      };
      walk(root, null);
      this.db.exec('COMMIT');
      return 1;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  getVersion(mapId: string): number | null {
    const row = this.db
      .prepare('SELECT version FROM maps WHERE id = ?')
      .get(mapId) as { version: number } | undefined;
    return row ? row.version : null;
  }

  getRootId(mapId: string): string | null {
    const row = this.db
      .prepare('SELECT root_id FROM maps WHERE id = ?')
      .get(mapId) as { root_id: string } | undefined;
    return row ? row.root_id : null;
  }

  /** 在一致快照中读取整张图：全部节点的父指针与全部父节点的孩子顺序。 */
  loadTree(mapId: string): { nodes: NodeRow[]; children: ChildrenRow[] } {
    this.db.exec('BEGIN');
    try {
      const nodes = this.db
        .prepare(
          'SELECT node_id AS nodeId, parent_id AS parentId FROM nodes WHERE map_id = ?',
        )
        .all(mapId) as unknown as NodeRow[];
      const rawChildren = this.db
        .prepare('SELECT parent_id AS parentId, kids_json AS kidsJson FROM children WHERE map_id = ?')
        .all(mapId) as unknown as { parentId: string; kidsJson: string }[];
      this.db.exec('COMMIT');
      const children: ChildrenRow[] = rawChildren.map((row) => ({
        parentId: row.parentId,
        kids: JSON.parse(row.kidsJson) as string[],
      }));
      return { nodes, children };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * 原子提交一批变更：仅当当前版本等于 expectedVersion 时生效，
   * 成功则版本恰好 +1；版本不匹配时不留任何修改。
   */
  applyBatch(
    mapId: string,
    expectedVersion: number,
    changes: BatchChanges,
  ): ApplyResult {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db
        .prepare('SELECT version FROM maps WHERE id = ?')
        .get(mapId) as { version: number } | undefined;
      if (!row) {
        this.db.exec('ROLLBACK');
        throw new Error(`map not found: ${mapId}`);
      }
      if (row.version !== expectedVersion) {
        this.db.exec('ROLLBACK');
        return { ok: false, reason: 'version_conflict' };
      }
      const updateNode = this.db.prepare(
        'UPDATE nodes SET parent_id = ? WHERE map_id = ? AND node_id = ?',
      );
      for (const update of changes.parentUpdates) {
        updateNode.run(update.parentId, mapId, update.nodeId);
      }
      const upsertChildren = this.db.prepare(
        `INSERT INTO children (map_id, parent_id, kids_json) VALUES (?, ?, ?)
         ON CONFLICT (map_id, parent_id) DO UPDATE SET kids_json = excluded.kids_json`,
      );
      for (const update of changes.childrenUpdates) {
        upsertChildren.run(mapId, update.parentId, JSON.stringify(update.kids));
      }
      const bumped = this.db
        .prepare('UPDATE maps SET version = version + 1 WHERE id = ? AND version = ?')
        .run(mapId, expectedVersion);
      if (Number(bumped.changes) !== 1) {
        this.db.exec('ROLLBACK');
        return { ok: false, reason: 'version_conflict' };
      }
      this.db.exec('COMMIT');
      return { ok: true, version: expectedVersion + 1 };
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // 已经回滚
      }
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }
}
