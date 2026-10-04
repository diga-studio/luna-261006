import { DerNode, isSequence, parseTlv } from './der';

export interface CertificateSignatures {
  /** TBSCertificate.signature */
  inner: DerNode;
  /** Certificate.signatureAlgorithm */
  outer: DerNode;
}

/**
 * Extract the two signature AlgorithmIdentifiers from a DER certificate.
 * Returns null when the structure is not a plausible X.509 certificate.
 * Only the fields needed for signature review are examined; the public key
 * and extensions are never parsed.
 */
export function extractSignatureAlgorithms(der: Uint8Array): CertificateSignatures | null {
  let certificate: DerNode;
  try {
    certificate = parseTlv(der);
  } catch {
    return null;
  }

  if (!isSequence(certificate) || certificate.children === null) return null;
  if (certificate.children.length !== 3) return null;

  const [tbs, outer] = certificate.children;
  if (tbs === undefined || outer === undefined) return null;
  if (!isSequence(tbs) || tbs.children === null) return null;
  if (!isSequence(outer)) return null;

  // TBSCertificate: version [0] EXPLICIT is optional; signature follows
  // serialNumber, so it sits at index 2 with a version and index 1 without.
  const first = tbs.children[0];
  if (first === undefined) return null;
  const hasVersion = first.tagClass === 2 && first.constructed && first.tagNumber === 0;
  const signatureIndex = hasVersion ? 2 : 1;
  if (tbs.children.length < signatureIndex + 5) return null;

  const inner = tbs.children[signatureIndex];
  if (inner === undefined || !isSequence(inner)) return null;

  return { inner, outer };
}
