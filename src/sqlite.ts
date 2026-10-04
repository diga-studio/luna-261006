/**
 * Minimal typed facade over the built-in `node:sqlite` module.
 *
 * Loaded via `require` so the library compiles against older @types/node
 * that predate the node:sqlite type declarations. Requires Node >= 22.5.
 */

export interface SqliteStatement {
  run(...params: Array<string | number | null>): void;
  get(...params: Array<string | number | null>): Record<string, unknown> | undefined;
  all(...params: Array<string | number | null>): Array<Record<string, unknown>>;
}

export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

interface DatabaseSyncConstructor {
  new (path: string): SqliteDatabase;
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const DatabaseSync: DatabaseSyncConstructor = require("node:sqlite").DatabaseSync;

export function openDatabase(path: string): SqliteDatabase {
  return new DatabaseSync(path);
}
