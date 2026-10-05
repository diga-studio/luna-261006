import { openDatabase, type Schema } from './db';
import { CloseConflictError } from './errors';
import { assertMonth, monthRange } from './months';
import { hireMonthOf, salaryAt } from './salary';
import type {
  CloseBatchResult,
  CloseLine,
  EmployeeCloseResult,
  EmployeeInit,
  Month,
  PayEstimator,
} from './types';

export interface PayrollServiceOptions {
  dbPath: string;
  estimatePay: PayEstimator;
}

function assertIntegerCents(value: number, what: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${what} must be an integer number of cents, got ${value}`);
  }
}

export class PayrollService {
  private readonly schema: Schema;
  private readonly estimatePay: PayEstimator;

  constructor(options: PayrollServiceOptions) {
    this.schema = openDatabase(options.dbPath);
    this.estimatePay = options.estimatePay;
  }

  async initEmployees(employees: EmployeeInit[]): Promise<void> {
    const stmt = this.schema.db.prepare(
      'INSERT OR REPLACE INTO employees (employee_id, hire_month, base_salary) VALUES (?, ?, ?)',
    );
    this.schema.db.exec('BEGIN');
    try {
      for (const e of employees) {
        assertMonth(e.hireMonth);
        assertIntegerCents(e.baseSalary, 'baseSalary');
        stmt.run(e.employeeId, e.hireMonth, e.baseSalary);
      }
      this.schema.db.exec('COMMIT');
    } catch (err) {
      this.schema.db.exec('ROLLBACK');
      throw err;
    }
  }

  async setSalary(employeeId: string, effectiveMonth: Month, salary: number): Promise<void> {
    assertMonth(effectiveMonth);
    assertIntegerCents(salary, 'salary');
    hireMonthOf(this.schema, employeeId);
    this.schema.db
      .prepare(
        'INSERT OR REPLACE INTO salary_changes (employee_id, effective_month, salary) VALUES (?, ?, ?)',
      )
      .run(employeeId, effectiveMonth, salary);
  }

  async closeBatch(requestId: string, employeeIds: string[], month: Month): Promise<CloseBatchResult> {
    assertMonth(month);
    if (!requestId) {
      throw new Error('requestId must be a non-empty string');
    }
    const existing = this.getCloseResult(requestId);
    if (existing) {
      return existing;
    }

    const uniqueEmployeeIds = [...new Set(employeeIds)];
    const employees: EmployeeCloseResult[] = [];
    for (const employeeId of uniqueEmployeeIds) {
      const hireMonth = hireMonthOf(this.schema, employeeId);
      if (hireMonth > month) {
        throw new Error(
          `cannot close month ${month} before hire month ${hireMonth} of employee ${employeeId}`,
        );
      }
      const lines: CloseLine[] = [];
      let total = 0;
      for (const m of monthRange(hireMonth, month)) {
        const salary = salaryAt(this.schema, employeeId, m);
        const payable = await this.estimatePay(employeeId, m, salary);
        assertIntegerCents(payable, `estimated pay for ${employeeId}@${m}`);
        const closedRow = this.schema.db
          .prepare('SELECT COALESCE(SUM(amount), 0) AS closed FROM close_lines WHERE employee_id = ? AND month = ?')
          .get(employeeId, m) as { closed: number | bigint };
        const closed = typeof closedRow.closed === 'bigint' ? Number(closedRow.closed) : closedRow.closed;
        const amount = payable - closed;
        lines.push({ employeeId, month: m, amount });
        total += amount;
      }
      employees.push({ employeeId, total, lines });
    }

    const conflicts: { employeeId: string; month: Month }[] = [];
    const conflictStmt = this.schema.db.prepare(
      `SELECT b.close_month AS close_month FROM batch_employees be
       JOIN batches b ON b.request_id = be.request_id
       WHERE be.employee_id = ? AND b.close_month = ? AND b.request_id != ?`,
    );
    for (const employeeId of uniqueEmployeeIds) {
      const rows = conflictStmt.all(employeeId, month, requestId) as { close_month: string }[];
      for (const row of rows) {
        conflicts.push({ employeeId, month: row.close_month });
      }
    }
    if (conflicts.length > 0) {
      throw new CloseConflictError(conflicts);
    }

    const total = employees.reduce((sum, e) => sum + e.total, 0);
    const db = this.schema.db;
    db.exec('BEGIN');
    try {
      db.prepare('INSERT INTO batches (request_id, close_month, total, created_at) VALUES (?, ?, ?, ?)')
        .run(requestId, month, total, new Date().toISOString());
      const empStmt = db.prepare(
        'INSERT INTO batch_employees (request_id, employee_id, total) VALUES (?, ?, ?)',
      );
      const lineStmt = db.prepare(
        'INSERT INTO close_lines (request_id, employee_id, month, amount) VALUES (?, ?, ?, ?)',
      );
      for (const e of employees) {
        empStmt.run(requestId, e.employeeId, e.total);
        for (const line of e.lines) {
          lineStmt.run(requestId, line.employeeId, line.month, line.amount);
        }
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    return { requestId, month, employees, total };
  }

  getCloseResult(requestId: string): CloseBatchResult | null {
    const batch = this.schema.db
      .prepare('SELECT close_month, total FROM batches WHERE request_id = ?')
      .get(requestId) as { close_month: string; total: number | bigint } | undefined;
    if (!batch) {
      return null;
    }
    const empRows = this.schema.db
      .prepare('SELECT employee_id, total FROM batch_employees WHERE request_id = ? ORDER BY employee_id')
      .all(requestId) as { employee_id: string; total: number | bigint }[];
    const lineStmt = this.schema.db.prepare(
      'SELECT month, amount FROM close_lines WHERE request_id = ? AND employee_id = ? ORDER BY month',
    );
    const employees: EmployeeCloseResult[] = empRows.map((row) => {
      const lines = (lineStmt.all(requestId, row.employee_id) as { month: string; amount: number | bigint }[])
        .map((l) => ({
          employeeId: row.employee_id,
          month: l.month,
          amount: typeof l.amount === 'bigint' ? Number(l.amount) : l.amount,
        }));
      return {
        employeeId: row.employee_id,
        total: typeof row.total === 'bigint' ? Number(row.total) : row.total,
        lines,
      };
    });
    return {
      requestId,
      month: batch.close_month,
      employees,
      total: typeof batch.total === 'bigint' ? Number(batch.total) : batch.total,
    };
  }

  close(): void {
    this.schema.db.close();
  }
}
