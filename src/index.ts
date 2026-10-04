import { parseSdp } from "./parser.js";
import { verifyNegotiation } from "./verify.js";
import { BANDWIDTH_LIMITS } from "./types.js";
import type { BandwidthPreset, VerifyResult } from "./types.js";

export { parseSdp, verifyNegotiation, BANDWIDTH_LIMITS };
export type { BandwidthPreset, VerifyResult };
export * from "./types.js";

export function checkNegotiation(
  offerSdp: string,
  answerSdp: string,
  preset: BandwidthPreset,
): VerifyResult {
  return verifyNegotiation(parseSdp(offerSdp), parseSdp(answerSdp), preset);
}
