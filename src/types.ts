/** 月份，格式 YYYY-MM，按字典序可比较。 */
export type Month = string;

/** 员工初始化信息。 */
export interface EmployeeSeed {
  employeeId: string;
  /** 入职月份，关账从该月起。 */
  hireMonth: Month;
  /** 初始月薪（本币整数分），自入职月起生效。 */
  initialSalary: number;
}

/**
 * 调用方提供的本地异步估算能力：
 * 按员工、月份、该月月薪返回该月应付整数分。固定输入结果固定。
 */
export type Estimator = (
  employeeId: string,
  month: Month,
  monthlySalary: number,
) => Promise<number>;

/** 单个月份的追补明细：该月应付额减去此前已归属金额的差额。 */
export interface CloseLine {
  month: Month;
  /** 差额（整数分），允许负数。 */
  amount: number;
}

/** 单名员工在一个批次中的关账结果。 */
export interface EmployeeCloseResult {
  employeeId: string;
  /** 本次应付：各月差额之和，允许负数。 */
  total: number;
  lines: CloseLine[];
}

export type CloseStatus = 'closed' | 'conflict';

/** 一个关账批次的结果。 */
export interface CloseBatchResult {
  requestId: string;
  month: Month;
  status: CloseStatus;
  employees: EmployeeCloseResult[];
}
