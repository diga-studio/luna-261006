export type BatchStatus = 'processing' | 'completed';

export interface BatchInfo {
  batchId: string;
  month: string;
  status: BatchStatus;
  total: number;
  done: number;
}

export interface MemberResult {
  memberId: string;
  commissionCents: number;
  needsReview: boolean;
}
