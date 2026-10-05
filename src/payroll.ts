import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from './db.js';
import { assertMonth, monthRange } from './months.js';
import type {
  CloseBatchResult,
  CloseLine,
  EmployeeCloseResult,
  EmployeeSeed,
  Estimator,
  Month,
} from './types.js';

interface EmployeeRow {
  employee_id: string;
  hire_month: string;
  initial_salary: number;
}

/** 月度工资追补关账库入口。 */
export class PayrollClose {
  private constructor(
    private readonly db: DatabaseSync,
    private readonly estimator: Estimator,
  ) {}

  /** 打开（必要时创建）位于 dbPath 的 SQLite 库。 */
  static async open(dbPath: string, estimator: Estimator): Promise<PayrollClose> {
    if (typeof estimator !== 'function') {
      throw new Error('estimator must be a function');
    }
    return new PayrollClose(openDatabase(dbPath), estimator);
  }

  /** 初始化员工名单（员工、入职月份、初始月薪）。重复初始化同一员工为幂等。 */
  async initEmployees(seeds: EmployeeSeed[]): Promise<void> {
    const insertEmployee = this.db.prepare(
      'INSERT OR IGNORE INTO employees (employee_id, hire_month, initial_salary) VALUES (?, ?, ?)',
    );
    const insertInitialSalary = this.db.prepare(
      'INSERT OR IGNORE INTO salary_changes (employee_id, effective_month, salary) VALUES (?, ?, ?)',
    );
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const seed of seeds) {
        assertMonth(seed.hireMonth);
        insertEmployee.run(seed.employeeId, seed.hireMonth, seed.initialSalary);
        insertInitialSalary.run(seed.employeeId, seed.hireMonth, seed.initialSalary);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** 改薪：自 effectiveMonth 起生效，同月重复设置替换原值。 */
  async setSalary(employeeId: string, effectiveMonth: Month, salary: number): Promise<void> {
    assertMonth(effectiveMonth);
    this.requireEmployee(employeeId);
    this.db
      .prepare(
        `INSERT INTO salary_changes (employee_id, effective_month, salary) VALUES (?, ?, ?)
         ON CONFLICT (employee_id, effective_month) DO UPDATE SET salary = excluded.salary`,
      )
      .run(employeeId, effectiveMonth, salary);
  }

  /**
   * 批量关账：对每名员工从入职月至 month 逐月重估并计算差额。
   * 整批原子入账；与其他批次在（员工，月份）上相交则整批冲突不入账。
   * 相同 requestId 重试返回首次结果。
   */
  async closeBatch(
    requestId: string,
    employeeIds: string[],
    month: Month,
  ): Promise<CloseBatchResult> {
    assertMonth(month);
    if (!requestId) {
      throw new Error('requestId must be a non-empty string');
    }
    const uniqueIds = [...new Set(employeeIds)];
    if (uniqueIds.length !== employeeIds.length) {
      throw new Error('employeeIds must not contain duplicates');
    }

    const existing = await this.getCloseResult(requestId);
    if (existing) {
      return existing;
    }

    const employees = uniqueIds.map((id) => this.requireEmployee(id));

    // 估算在事务外进行（调用方异步能力），写入与冲突检查在事务内原子完成。
    const computed: EmployeeCloseResult[] = [];
    for (const emp of employees) {
      const lines: CloseLine[] = [];
      let total = 0;
      for (const m of monthRange(emp.hire_month, month)) {
        const salary = this.salaryFor(emp.employee_id, m);
        const payable = await this.estimator(emp.employee_id, m, salary);
        const attributed = this.attributedAmount(emp.employee_id, m);
        const amount = payable - attributed;
        lines.push({ month: m, amount });
        total += amount;
      }
      computed.push({ employeeId: emp.employee_id, total, lines });
    }

    this.db.exec('BEGIN IMMEDIATE');
    try {
      // 并发重试：事务内复查请求标识，已存在则放弃本次写入并回放已入账结果。
      const raced = this.db
        .prepare('SELECT request_id FROM close_requests WHERE request_id = ?')
        .get(requestId);
      if (raced) {
        this.db.exec('ROLLBACK');
        const stored = await this.getCloseResult(requestId);
        if (!stored) {
          throw new Error(`inconsistent state for request ${requestId}`);
        }
        return stored;
      }

      // 冲突：批次携带一个月份，（员工，月份）与其他已入账请求相交即整批冲突。
      const conflictStmt = this.db.prepare(
        `SELECT 1 FROM close_employee_results r
         JOIN close_requests q ON q.request_id = r.request_id
         WHERE r.employee_id = ? AND q.month = ? LIMIT 1`,
      );
      for (const emp of employees) {
        if (conflictStmt.get(emp.employee_id, month)) {
          this.db.exec('ROLLBACK');
          return { requestId, month, status: 'conflict', employees: [] };
        }
      }

      this.db
        .prepare(
          `INSERT INTO close_requests (request_id, month, status, created_at)
           VALUES (?, ?, 'closed', ?)`,
        )
        .run(requestId, month, new Date().toISOString());
      const insertResult = this.db.prepare(
        'INSERT INTO close_employee_results (request_id, employee_id, total) VALUES (?, ?, ?)',
      );
      const insertLine = this.db.prepare(
        'INSERT INTO close_lines (request_id, employee_id, month, amount) VALUES (?, ?, ?, ?)',
      );
      for (const result of computed) {
        insertResult.run(requestId, result.employeeId, result.total);
        for (const line of result.lines) {
          insertLine.run(requestId, result.employeeId, line.month, line.amount);
        }
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    return { requestId, month, status: 'closed', employees: computed };
  }

  /** 按请求标识读取已入账的关账结果；不存在返回 null。 */
  async getCloseResult(requestId: string): Promise<CloseBatchResult | null> {
    const request = this.db
      .prepare('SELECT request_id, month FROM close_requests WHERE request_id = ?')
      .get(requestId) as { request_id: string; month: string } | undefined;
    if (!request) {
      return null;
    }
    const resultRows = this.db
      .prepare(
        'SELECT employee_id, total FROM close_employee_results WHERE request_id = ? ORDER BY employee_id',
      )
      .all(requestId) as unknown as { employee_id: string; total: number }[];
    const lineStmt = this.db.prepare(
      'SELECT month, amount FROM close_lines WHERE request_id = ? AND employee_id = ? ORDER BY month',
    );
    const employees: EmployeeCloseResult[] = resultRows.map((row) => {
      const lines = (
        lineStmt.all(requestId, row.employee_id) as unknown as {
          month: string;
          amount: number;
        }[]
      ).map((l) => ({ month: l.month, amount: l.amount }));
      return { employeeId: row.employee_id, total: row.total, lines };
    });
    return { requestId, month: request.month, status: 'closed', employees };
  }

  /** 关闭底层数据库连接。 */
  async close(): Promise<void> {
    this.db.close();
  }

  private requireEmployee(employeeId: string): EmployeeRow {
    const row = this.db
      .prepare('SELECT employee_id, hire_month, initial_salary FROM employees WHERE employee_id = ?')
      .get(employeeId) as EmployeeRow | undefined;
    if (!row) {
      throw new Error(`unknown employee: ${employeeId}`);
    }
    return row;
  }

  /** 某员工某月的生效月薪：生效月不晚于该月的最近一条记录。 */
  private salaryFor(employeeId: string, month: Month): number {
    const row = this.db
      .prepare(
        `SELECT salary FROM salary_changes
         WHERE employee_id = ? AND effective_month <= ?
         ORDER BY effective_month DESC LIMIT 1`,
      )
      .get(employeeId, month) as { salary: number } | undefined;
    if (!row) {
      throw new Error(`no salary record for employee ${employeeId} at ${month}`);
    }
    return row.salary;
  }

  /** 此前所有批次中已归属于（员工，月份）的金额合计。 */
  private attributedAmount(employeeId: string, month: Month): number {
    const row = this.db
      .prepare(
        'SELECT COALESCE(SUM(amount), 0) AS total FROM close_lines WHERE employee_id = ? AND month = ?',
      )
      .get(employeeId, month) as { total: number };
    return row.total;
  }
}
