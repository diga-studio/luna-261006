import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DatabaseSync } from "node:sqlite";

export function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "canary-test-"));
}

/** 创建业务库并置于指定版本 */
export function createDb(file: string, version: number, statements: string[]): void {
  const db = new DatabaseSync(file);
  try {
    for (const stmt of statements) db.exec(stmt);
    db.exec(`PRAGMA user_version = ${version}`);
  } finally {
    db.close();
  }
}

export interface DbDump {
  userVersion: number;
  tables: Record<string, unknown[]>;
  sequences: unknown[];
}

/** 全量读取库内容（数据、自增进度、版本），用于断言“完全恢复” */
function plain(rows: unknown[]): unknown[] {
  return rows.map((r) => ({ ...(r as object) }));
}

export function dumpDb(file: string): DbDump {
  const db = new DatabaseSync(file);
  try {
    const versionRow = db.prepare("PRAGMA user_version").get() as { user_version: number };
    const tables: Record<string, unknown[]> = {};
    const tableRows = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as unknown as { name: string }[];
    for (const { name } of tableRows) {
      tables[name] = plain(db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all());
    }
    let sequences: unknown[] = [];
    const hasSeq = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'")
      .get();
    if (hasSeq) {
      sequences = plain(db.prepare("SELECT * FROM sqlite_sequence ORDER BY name").all());
    }
    return { userVersion: versionRow.user_version, tables, sequences };
  } finally {
    db.close();
  }
}

/** 标准业务库 fixture：含自增表与待删除数据 */
export function standardFixture(extraStatements: string[] = []): string[] {
  return [
    "CREATE TABLE items(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, qty INTEGER)",
    "CREATE TABLE log_entries(id INTEGER PRIMARY KEY AUTOINCREMENT, note TEXT)",
    "INSERT INTO items(name, qty) VALUES ('apple', 10), ('obsolete', 1), ('cherry', 3)",
    "INSERT INTO log_entries(note) VALUES ('seed')",
    ...extraStatements,
  ];
}

/** 非幂等迁移：累计加值、删除数据、写日志（每执行一次效果都会累积） */
export const CUMULATIVE_SQL = `
  ALTER TABLE items ADD COLUMN code TEXT;
  UPDATE items SET qty = qty + 1;
  DELETE FROM items WHERE name = 'obsolete';
  INSERT INTO log_entries(note) VALUES ('migrated');
`;

export class SimulatedCrash extends Error {
  constructor(public point: string) {
    super(`simulated crash at ${point}`);
  }
}
