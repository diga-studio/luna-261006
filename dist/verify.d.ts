import type { PlanInput, PlanResult } from "./types.js";
export interface VerifyReport {
    valid: boolean;
    errors: string[];
}
/**
 * Independently re-checks a plan result against the input snapshot.
 * Never trusts the `ok` flag: success results are fully re-validated,
 * failure certificates are recomputed from scratch. Optimality itself is
 * not re-proven here.
 */
export declare function verify(input: PlanInput, result: PlanResult): VerifyReport;
