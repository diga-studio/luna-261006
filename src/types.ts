export type ImportStatus = "running" | "done";

export interface AdvanceResult {
  done: boolean;
  processed: number;
  totalProcessed: number;
  succeeded: number;
  failed: number;
}

export interface RowResult {
  recordNo: number;
  ok: boolean;
  externalId: string | null;
  revision: number | null;
  error: string | null;
}

export interface InspectResult {
  processed: number;
  succeeded: number;
  failed: number;
  rows: RowResult[];
}

export interface CaseRecord {
  externalId: string;
  category: string;
  description: string;
  revision: number;
}

export interface TestHooks {
  beforeCommit?: () => void;
  afterCommit?: () => void;
  onRead?: (offset: number, length: number) => void;
}

export interface ImporterOptions {
  hooks?: TestHooks;
}
