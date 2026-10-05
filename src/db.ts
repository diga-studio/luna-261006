import { DatabaseSync } from 'node:sqlite';

export interface Schema {
  db: DatabaseSync;
}

const DDL = `
CREATE TABLE IF NOT EXISTS employees (
  employee_id TEXT PRIMARY KEY,
  hire_month  TEXT NOT NULL,
  base_salary INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS salary_changes (
  employee_id     TEXT NOT NULL,
  effective_month TEXT NOT NULL,
  salary          INTEGER NOT NULL,
  PRIMARY KEY (employee_id, effective_month)
);

CREATE TABLE IF NOT EXISTS batches (
  request_id  TEXT PRIMARY KEY,
  close_month TEXT NOT NULL,
  total       INTEGER NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS batch_employees (
  request_id  TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  total       INTEGER NOT NULL,
  PRIMARY KEY (request_id, employee_id)
);

CREATE TABLE IF NOT EXISTS close_lines (
  request_id  TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  month       TEXT NOT NULL,
  amount      INTEGER NOT NULL,
  PRIMARY KEY (request_id, employee_id, month)
);
`;

export function openDatabase(dbPath: string): Schema {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(DDL);
  return { db };
}
