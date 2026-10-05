import type { PlanInput } from "./types.js";
/**
 * Shared, normalized view of an input snapshot. Built once per plan/verify
 * call; the input is treated as immutable for the duration of a call.
 *
 * All per-task / per-judge data is indexed by position in the input arrays.
 */
export interface BatchContext {
    input: PlanInput;
    judgeIndexById: Map<string, number>;
    taskIndexById: Map<string, number>;
    /** Locked assignments per judge (across all tasks). */
    lockedCount: number[];
    /** capacity - lockedCount, per judge. */
    remainingCapacity: number[];
    /** requiredJudges - lockedJudgeIds.length, per task. */
    remainingSlots: number[];
    /** eligible[t][j]: judge j may review task t (ignores locks). */
    eligible: boolean[][];
    /** candidate[t][j]: eligible and not locked into task t. */
    candidate: boolean[][];
    /** preferred[t][j]: declared soft preference. */
    preferred: boolean[][];
    /** lockedPair[t][j]: judge j is locked into task t. */
    lockedPair: boolean[][];
}
export declare function buildContext(input: PlanInput): BatchContext;
