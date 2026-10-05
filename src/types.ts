export type Difficulty = "基础" | "进阶" | "高阶";

export interface QuestionVersion {
  questionId: string;
  version: number;
  category: string;
  difficulty: Difficulty;
}

export interface QuestionBank {
  readonly questions: readonly QuestionVersion[];
}

export type Quota = Readonly<Record<string, number>>;

export type AssembleResult =
  | { readonly ok: true; readonly questions: readonly QuestionVersion[] }
  | { readonly ok: false; readonly reason: string };
