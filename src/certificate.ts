/** X.509 Certificate / TBSCertificate extraction (RFC 5280 section 4.1). */

import { DerElement, DerError, parseDer, TAG } from "./der";

export interface CertificateParts {
  /** Certificate.signatureAlgorithm AlgorithmIdentifier element. */
  outerSignatureAlgorithm: DerElement;
  /** TBSCertificate.signature AlgorithmIdentifier element. */
  innerSignatureAlgorithm: DerElement;
}

function requireSequence(el: DerElement, what: string): DerElement {
  if (el.tag !== TAG.SEQUENCE) throw new DerError(`${what} must be a SEQUENCE`);
  return el;
}

function isAlgorithmIdentifier(el: DerElement): boolean {
  return (
    el.tag === TAG.SEQUENCE &&
    el.children.length >= 1 &&
    el.children.length <= 2 &&
    el.children[0].tag === TAG.OID
  );
}

/** Extract the inner/outer signature AlgorithmIdentifiers from a DER certificate. */
export function extractSignatureAlgorithms(der: Uint8Array): CertificateParts {
  const cert = requireSequence(parseDer(der), "Certificate");
  if (cert.children.length !== 3) {
    throw new DerError("Certificate must have exactly 3 fields");
  }
  const [tbs, outer, signatureValue] = cert.children;
  requireSequence(tbs, "TBSCertificate");
  if (signatureValue.tag !== TAG.BIT_STRING) {
    throw new DerError("signatureValue must be a BIT STRING");
  }
  // version is [0] EXPLICIT and optional; when absent the first field is serialNumber.
  const hasVersion = tbs.children[0].tag === 0xa0;
  if (tbs.children.length < (hasVersion ? 7 : 6)) {
    throw new DerError("TBSCertificate has too few fields");
  }
  const inner = tbs.children[hasVersion ? 2 : 1];
  if (!isAlgorithmIdentifier(inner)) {
    throw new DerError("TBSCertificate.signature is not an AlgorithmIdentifier");
  }
  if (!isAlgorithmIdentifier(outer)) {
    throw new DerError("Certificate.signatureAlgorithm is not an AlgorithmIdentifier");
  }
  return { outerSignatureAlgorithm: outer, innerSignatureAlgorithm: inner };
}
