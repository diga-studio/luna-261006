import {
  NormalizedAlgorithm,
  SignatureDescription,
  descriptionsEqual,
  normalizeSignatureAlgorithm,
} from './algorithms';
import { extractSignatureAlgorithms } from './certificate';

export type Verdict = 'SAFE' | 'WEAK' | 'UNKNOWN' | 'INVALID';

function usesSha1(desc: SignatureDescription): boolean {
  if (desc.kind === 'rsa') return desc.hash === 'sha1';
  return desc.hash === 'sha1' || desc.mgfHash === 'sha1';
}

function rawEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function compare(inner: NormalizedAlgorithm, outer: NormalizedAlgorithm): Verdict {
  if (inner.desc !== null && outer.desc !== null) {
    if (!descriptionsEqual(inner.desc, outer.desc)) return 'INVALID';
    return usesSha1(inner.desc) ? 'WEAK' : 'SAFE';
  }
  // At least one side is not fully recognized: fall back to comparing the
  // original encodings byte for byte.
  return rawEqual(inner.raw, outer.raw) ? 'UNKNOWN' : 'INVALID';
}

/**
 * Review the signature algorithm of one DER-encoded certificate.
 * SAFE only means the algorithm passed this review, not that the
 * certificate is trustworthy.
 */
export function inspectCertificate(der: Uint8Array): Verdict {
  const signatures = extractSignatureAlgorithms(der);
  if (signatures === null) return 'INVALID';
  const inner = normalizeSignatureAlgorithm(signatures.inner);
  const outer = normalizeSignatureAlgorithm(signatures.outer);
  return compare(inner, outer);
}

/** True only when every certificate in the chain reviews as SAFE. */
export function inspectChain(certs: Uint8Array[]): boolean {
  return certs.every((cert) => inspectCertificate(cert) === 'SAFE');
}
