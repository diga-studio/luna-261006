declare module 'node:sqlite' {
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
  export class StatementSync {
    run(...params: Array<string | number | bigint | null>): { changes: number | bigint; lastInsertRowid: number | bigint };
    get(...params: Array<string | number | bigint | null>): Record<string, unknown> | undefined;
    all(...params: Array<string | number | bigint | null>): Array<Record<string, unknown>>;
  }
}
