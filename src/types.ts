export interface Key {
  course: string;
  semester: string;
}

export type Strategy = "max" | "last";

export interface Rule {
  weights: { homework: number; midterm: number; final: number };
  strategy: Strategy;
  passLine: number;
}

export interface Attempts {
  homework: number[];
  midterm: number[];
  final: number[];
}

export interface GradeRow {
  studentId: string;
  inputVersion: number;
  total: number;
  pass: boolean;
}

export interface GradebookSnapshot {
  ruleVersion: number;
  rows: GradeRow[];
}

export interface RecomputeHooks {
  betweenStudents?: (key: Key, studentId: string, processed: number) => Promise<void>;
}

export interface GradebookOptions {
  hooks?: RecomputeHooks;
}

export function keyId(key: Key): string {
  return key.course + "" + key.semester;
}
