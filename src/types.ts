/** 检查结论：放行 / 隔离 / 人工复核 */
export type Verdict = 'allow' | 'quarantine' | 'review';

export interface InspectionResult {
  verdict: Verdict;
  /** 得出该结论的原因（便于排查，不持久化） */
  reason: string;
}
