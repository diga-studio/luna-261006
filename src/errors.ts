import type { Month } from './types';

/** 不同请求在相同员工与月份上发生交集时抛出，整批不入账 */
export class CloseConflictError extends Error {
  readonly conflicts: { employeeId: string; month: Month }[];
  constructor(conflicts: { employeeId: string; month: Month }[]) {
    super(
      'close batch conflicts with existing records: ' +
        conflicts.map((c) => `${c.employeeId}@${c.month}`).join(', '),
    );
    this.name = 'CloseConflictError';
    this.conflicts = conflicts;
  }
}

export class UnknownEmployeeError extends Error {
  constructor(employeeId: string) {
    super(`unknown employee: ${employeeId}`);
    this.name = 'UnknownEmployeeError';
  }
}
