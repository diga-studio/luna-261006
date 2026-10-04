import { DatabaseSync } from 'node:sqlite';
import {
  MapAlreadyExistsError,
  MapNotFoundError,
  VersionConflictError,
} from './errors.js';
import { buildStateFromInput } from './tree.js';
import type { EditOperation, MindMapNodeInput, NodeId, TreeState } from './types.js';

/**
 * SQLite 持久化层。
 * maps 表存版本与根；nodes 表每节点一行 (parent_id, position)。
 * 提交只写受影响父节点的孩子增量，并在单个 IMMEDIATE 事务内
 * 校验版本：版本过期整批回滚，不留任何修改。
 */
export class MapStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 10000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS maps (
        map_id TEXT PRIMARY KEY,
        root_id TEXT NOT NULL,
        version INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS nodes (
        map_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        parent_id TEXT,
        position INTEGER NOT NULL,
        PRIMARY KEY (map_id, node_id)
      );
      CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes (map_id, parent_id, position);
    `);
  }

  /** 建图：写入整棵树，初始版本为 1。 */
  createMap(mapId: string, root: MindMapNodeInput): { version: number; state: TreeState } {
    const existing = this.db.prepare('SELECT version FROM maps WHERE map_id = ?').get(mapId);
    if (existing !== undefined) {
      throw new MapAlreadyExistsError(mapId);
    }
    const state = buildStateFromInput(root);
    const initialVersion = 1;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare('INSERT INTO maps (map_id, root_id, version) VALUES (?, ?, ?)')
        .run(mapId, state.rootId, initialVersion);
      const insert = this.db.prepare(
        'INSERT INTO nodes (map_id, node_id, parent_id, position) VALUES (?, ?, ?, ?)',
      );
      insert.run(mapId, state.rootId, null, 0);
      for (const [parentId, kids] of state.children) {
        for (let index = 0; index < kids.length; index += 1) {
          insert.run(mapId, kids[index]!, parentId, index);
        }
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { version: initialVersion, state };
  }

  /** 读取当前版本；导图不存在返回 null。 */
  loadVersion(mapId: string): number | null {
    const row = this.db.prepare('SELECT version FROM maps WHERE map_id = ?').get(mapId) as
      | { version: number }
      | undefined;
    return row === undefined ? null : row.version;
  }

  /** 读取完整已提交状态；不存在返回 null。 */
  loadMap(mapId: string): { version: number; state: TreeState } | null {
    const mapRow = this.db
      .prepare('SELECT root_id AS rootId, version FROM maps WHERE map_id = ?')
      .get(mapId) as { rootId: string; version: number } | undefined;
    if (mapRow === undefined) {
      return null;
    }
    const rows = this.db
      .prepare(
        'SELECT node_id AS nodeId, parent_id AS parentId, position FROM nodes WHERE map_id = ? ORDER BY parent_id, position',
      )
      .all(mapId) as { nodeId: string; parentId: string | null; position: number }[];
    const parent = new Map<NodeId, NodeId>();
    const children = new Map<NodeId, NodeId[]>();
    for (const row of rows) {
      if (!children.has(row.nodeId)) {
        children.set(row.nodeId, []);
      }
      if (row.parentId !== null) {
        parent.set(row.nodeId, row.parentId);
        let kids = children.get(row.parentId);
        if (kids === undefined) {
          kids = [];
          children.set(row.parentId, kids);
        }
        kids.push(row.nodeId);
      }
    }
    return { version: mapRow.version, state: { rootId: mapRow.rootId, parent, children } };
  }

  /**
   * 在单个 IMMEDIATE 事务内校验 expectedVersion 仍为当前版本，
   * 写入受影响父节点的孩子增量，版本恰好 +1。
   * 版本过期抛 VersionConflictError，不落任何修改。
   */
  commitMap(
    mapId: string,
    expectedVersion: number,
    prevState: TreeState,
    nextState: TreeState,
    edits: EditOperation[],
  ): number {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT version FROM maps WHERE map_id = ?').get(mapId) as
        | { version: number }
        | undefined;
      if (row === undefined) {
        throw new MapNotFoundError(mapId);
      }
      if (row.version !== expectedVersion) {
        throw new VersionConflictError(expectedVersion, row.version);
      }
      const affectedParents = new Set<NodeId>();
      for (const edit of edits) {
        affectedParents.add(prevState.parent.get(edit.nodeId)!);
        affectedParents.add(edit.newParentId);
      }
      const update = this.db.prepare(
        'UPDATE nodes SET parent_id = ?, position = ? WHERE map_id = ? AND node_id = ?',
      );
      for (const parentId of affectedParents) {
        const kids = nextState.children.get(parentId)!;
        for (let index = 0; index < kids.length; index += 1) {
          update.run(parentId, index, mapId, kids[index]!);
        }
      }
      const nextVersion = row.version + 1;
      this.db
        .prepare('UPDATE maps SET version = ? WHERE map_id = ?')
        .run(nextVersion, mapId);
      this.db.exec('COMMIT');
      return nextVersion;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }
}
