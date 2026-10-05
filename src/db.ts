import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS employees (
  employee_id    TEXT PRIMARY KEY,
  hire_month     TEXT NOT NULL,
  initial_salary INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS salary_changes (
  employee_id     TEXT NOT NULL,
  effective_month TEXT NOT NULL,
  salary          INTEGER NOT NULL,
  PRIMARY KEY (employee_id, effective_month)
);

CREATE TABLE IF NOT EXISTS close_requests (
  request_id TEXT PRIMARY KEY,
  month      TEXT NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('closed')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS close_employee_results (
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

CREATE INDEX IF NOT EXISTS idx_close_lines_emp_month
  ON close_lines (employee_id, month);
`;

/** 打开（必要时创建）数据库并建表。 */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}
