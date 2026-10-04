/** 需求优先级：高 / 中 / 低。 */
export type Priority = 'high' | 'medium' | 'low';

export interface Employee {
  id: string;
}

export interface Demand {
  id: string;
  departmentId: string;
  familyId: string;
  /** 需求人数（正整数）。 */
  headcount: number;
  priority: Priority;
}

/** 上游给出的候选配对及匹配分（0-100 整数）。未列出的员工×需求组合不允许匹配。 */
export interface CandidatePair {
  employeeId: string;
  demandId: string;
  score: number;
}

export interface Department {
  id: string;
  /** 部门总人数上限。 */
  capacity: number;
}

/** 某部门内某职族的人数上限（仅约束该部门内该职族）。 */
export interface FamilyCapacity {
  departmentId: string;
  familyId: string;
  capacity: number;
}

export interface Assignment {
  employeeId: string;
  demandId: string;
}

/** 规划快照：只在内存中使用，求解过程不会修改它。 */
export interface PlanningSnapshot {
  employees: Employee[];
  demands: Demand[];
  candidates: CandidatePair[];
  departments: Department[];
  familyCapacities: FamilyCapacity[];
  /** 当前分配（输入保证可行）。 */
  currentAssignments: Assignment[];
  /** 当前分配中被冻结的子集，必须原样保留。 */
  frozenAssignments: Assignment[];
}

/** 方案的五项目标值，按字典序从先到后比较。 */
export interface PlanMetrics {
  highFilled: number;
  mediumFilled: number;
  lowFilled: number;
  totalScore: number;
  /** 换岗人数：原本已分配且新去向不同（含变为未分配）的员工数。 */
  moves: number;
}

export interface AllocationPlan {
  assignments: Assignment[];
  metrics: PlanMetrics;
}
