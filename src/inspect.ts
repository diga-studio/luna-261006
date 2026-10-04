/** Public inspection API. */

import { extractSignatureAlgorithms } from "./certificate";
import { normalizeSignatureAlgorithm, normalizedEqual } from "./algorithms";
import { DerError } from "./der";

export type Verdict = "SAFE" | "WEAK" | "UNKNOWN" | "INVALID";

/**
 * Review the signature algorithm of one DER-encoded certificate snapshot.
 * SAFE only means the snapshot passes this algorithm review; it does NOT
 * mean the certificate is trustworthy.
 */
export function inspectCertificate(der: Uint8Array): Verdict {
  try {
    const { outerSignatureAlgorithm, innerSignatureAlgorithm } =
      extractSignatureAlgorithms(der);
    const outer = normalizeSignatureAlgorithm(outerSignatureAlgorithm);
    const inner = normalizeSignatureAlgorithm(innerSignatureAlgorithm);
    if (!normalizedEqual(outer, inner)) return "INVALID";
    if (outer.kind === "unknown") return "UNKNOWN";
    if (outer.kind === "rsa") {
      return outer.hash === "SHA-1" ? "WEAK" : "SAFE";
    }
    return outer.hash === "SHA-1" || outer.mgf1Hash === "SHA-1" ? "WEAK" : "SAFE";
  } catch (err) {
    if (err instanceof DerError) return "INVALID";
    throw err;
  }
}

/** Returns true only when every certificate in the chain is SAFE. */
export function inspectChain(certs: Uint8Array[]): boolean {
  return certs.every((cert) => inspectCertificate(cert) === "SAFE");
}
