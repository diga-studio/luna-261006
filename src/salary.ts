import type { Month } from './types';
import type { Schema } from './db';
import { UnknownEmployeeError } from './errors';

interface EmployeeRow {
  hire_month: string;
  base_salary: number | bigint;
}

interface SalaryRow {
  salary: number | bigint;
}

/** 解析某员工在某个月份生效的月薪：生效月 <= month 的最后一条改薪，否则初始月薪 */
export function salaryAt(schema: Schema, employeeId: string, month: Month): number {
  const employee = schema.db
    .prepare('SELECT hire_month, base_salary FROM employees WHERE employee_id = ?')
    .get(employeeId) as EmployeeRow | undefined;
  if (!employee) {
    throw new UnknownEmployeeError(employeeId);
  }
  const change = schema.db
    .prepare(
      `SELECT salary FROM salary_changes
       WHERE employee_id = ? AND effective_month <= ?
       ORDER BY effective_month DESC LIMIT 1`,
    )
    .get(employeeId, month) as SalaryRow | undefined;
  const value = change ? change.salary : employee.base_salary;
  return typeof value === 'bigint' ? Number(value) : value;
}

/** 员工入职月份，供关账确定起始月 */
export function hireMonthOf(schema: Schema, employeeId: string): Month {
  const employee = schema.db
    .prepare('SELECT hire_month FROM employees WHERE employee_id = ?')
    .get(employeeId) as { hire_month: string } | undefined;
  if (!employee) {
    throw new UnknownEmployeeError(employeeId);
  }
  return employee.hire_month;
}
