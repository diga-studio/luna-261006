export type {
  Conflict,
  ConflictChoice,
  Edit,
  LineMatch,
  MergeChunk,
  MergeResult,
} from './types';
export { matchLines, computeEdits } from './diff';
export { merge, resolve } from './merge';
