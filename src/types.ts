/** 月份，格式 YYYY-MM，如 "2026-03" */
export type Month = string;

/** 调用方初始化员工时提供的信息 */
export interface EmployeeInit {
  employeeId: string;
  /** 入职月份（含），自该月起参与关账 */
  hireMonth: Month;
  /** 初始月薪，员工本币整数分 */
  baseSalary: number;
}

/** 本地异步估算能力：按员工、月份、月薪返回该月应付整数分，固定输入结果固定 */
export type PayEstimator = (
  employeeId: string,
  month: Month,
  monthlySalary: number,
) => Promise<number>;

/** 一条关账明细：某员工某个月本次入账的差额（可为负） */
export interface CloseLine {
  employeeId: string;
  month: Month;
  amount: number;
}

/** 一名员工在一批关账中的结果 */
export interface EmployeeCloseResult {
  employeeId: string;
  /** 本次应付 = 各月差额之和 */
  total: number;
  lines: CloseLine[];
}

/** 一批关账的完整结果（入账与回放共用同一结构） */
export interface CloseBatchResult {
  requestId: string;
  month: Month;
  employees: EmployeeCloseResult[];
  total: number;
}
