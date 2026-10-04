/** Priority tier of a demand item. */
export type Priority = 'high' | 'medium' | 'low';

export interface Employee {
  id: string;
}

export interface DemandItem {
  id: string;
  departmentId: string;
  familyId: string;
  /** Required headcount for this demand item (positive integer). */
  headcount: number;
  priority: Priority;
}

/** A permitted employee->demand pairing with an upstream match score (0-100). */
export interface CandidatePair {
  employeeId: string;
  demandId: string;
  score: number;
}

export interface Assignment {
  employeeId: string;
  demandId: string;
}

/** Per-family headcount cap, scoped to a single department. */
export interface FamilyCap {
  familyId: string;
  max: number;
}

export interface DepartmentQuota {
  departmentId: string;
  /** Total headcount cap for the department. */
  maxTotal: number;
  /** Per-family caps within this department only. */
  familyCaps: FamilyCap[];
}

export interface PlanningSnapshot {
  employees: Employee[];
  demands: DemandItem[];
  candidates: CandidatePair[];
  currentAssignments: Assignment[];
  /** Subset of currentAssignments that must be preserved as-is. */
  frozenAssignments: Assignment[];
  departments: DepartmentQuota[];
}

export interface AllocationPlan {
  /** Full assignment list of the plan, including frozen assignments. */
  assignments: Assignment[];
}

/** Objective breakdown of a plan, compared lexicographically. */
export interface PlanStats {
  highFilled: number;
  mediumFilled: number;
  lowFilled: number;
  totalScore: number;
  /** Employees that were assigned before and changed demand or became unassigned. */
  moves: number;
}
