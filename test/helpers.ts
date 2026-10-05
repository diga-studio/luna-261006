import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface Workspace {
  dir: string;
  stateDbPath: string;
  dbPaths: string[];
  cleanup: () => void;
}

export function makeWorkspace(dbCount: number): Workspace {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-test-'));
  const dbPaths: string[] = [];
  for (let i = 0; i < dbCount; i++) {
    dbPaths.push(path.join(dir, `biz-${i}.db`));
  }
  return {
    dir,
    stateDbPath: path.join(dir, 'state.db'),
    dbPaths,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/** 创建业务库：写入起始版本与初始数据 */
export function createBizDb(file: string, version: number, setupSql: string): void {
  const db = new DatabaseSync(file);
  try {
    db.exec('CREATE TABLE __canary_meta (version INTEGER NOT NULL)');
    db.prepare('INSERT INTO __canary_meta (version) VALUES (?)').run(version);
    if (setupSql) db.exec(setupSql);
  } finally {
    db.close();
  }
}

export function getVersion(file: string): number {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db.prepare('SELECT version FROM __canary_meta').get() as
      | { version: number }
      | undefined;
    if (!row) throw new Error(`no version row in ${file}`);
    return row.version;
  } finally {
    db.close();
  }
}

export function queryAll(file: string, sql: string): Record<string, unknown>[] {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare(sql).all() as unknown as Record<string, unknown>[];
  } finally {
    db.close();
  }
}

export function tableExists(file: string, table: string): boolean {
  const rows = queryAll(
    file,
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${table}'`,
  );
  return rows.length > 0;
}

/** 读取 sqlite_sequence 中某表的自增进度；不存在则返回 null */
export function seqValue(file: string, table: string): number | null {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const has = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'")
      .get();
    if (!has) return null;
    const row = db.prepare('SELECT seq FROM sqlite_sequence WHERE name = ?').get(table) as
      | { seq: number }
      | undefined;
    return row ? row.seq : null;
  } finally {
    db.close();
  }
}
