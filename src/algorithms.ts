/** Normalization of signature AlgorithmIdentifier values. */

import { DerElement, DerError, decodeOid, TAG } from "./der";
import { OID } from "./oids";

export type HashName = "SHA-1" | "SHA-256" | "SHA-384" | "SHA-512";

export type NormalizedSignature =
  | { kind: "rsa"; hash: HashName }
  | { kind: "rsassa-pss"; hash: HashName; mgf1Hash: HashName; saltLength: number }
  | { kind: "unknown"; raw: Uint8Array };

const HASH_BY_OID: Record<string, HashName> = {
  [OID.sha1]: "SHA-1",
  [OID.sha256]: "SHA-256",
  [OID.sha384]: "SHA-384",
  [OID.sha512]: "SHA-512",
};

const RSA_HASH_BY_OID: Record<string, HashName> = {
  [OID.sha1WithRSAEncryption]: "SHA-1",
  [OID.sha256WithRSAEncryption]: "SHA-256",
  [OID.sha384WithRSAEncryption]: "SHA-384",
  [OID.sha512WithRSAEncryption]: "SHA-512",
};

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function oidOf(algorithm: DerElement): string {
  return decodeOid(algorithm.children[0].value);
}

function paramsOf(algorithm: DerElement): DerElement | null {
  return algorithm.children.length === 2 ? algorithm.children[1] : null;
}

/** NULL parameter and absent parameter are equivalent for supported algorithms. */
function isNullOrAbsent(params: DerElement | null): boolean {
  return params === null || (params.tag === TAG.NULL && params.value.length === 0);
}

/**
 * Normalize a hash AlgorithmIdentifier (as used inside RSASSA-PSS params).
 * Returns null when the OID or parameters are not one of the four supported hashes.
 */
function normalizeHashAlgorithm(algorithm: DerElement): HashName | null {
  if (
    algorithm.tag !== TAG.SEQUENCE ||
    algorithm.children.length < 1 ||
    algorithm.children.length > 2 ||
    algorithm.children[0].tag !== TAG.OID
  ) {
    throw new DerError("malformed hash AlgorithmIdentifier");
  }
  const hash = HASH_BY_OID[oidOf(algorithm)];
  if (hash === undefined) return null;
  if (!isNullOrAbsent(paramsOf(algorithm))) return null;
  return hash;
}

function decodeUnsignedInteger(el: DerElement, what: string): number {
  if (el.tag !== TAG.INTEGER || el.value.length === 0) {
    throw new DerError(`${what} must be an INTEGER`);
  }
  if (el.value[0] & 0x80) throw new DerError(`${what} must be non-negative`);
  let n = 0;
  for (const b of el.value) {
    n = n * 256 + b;
    if (!Number.isSafeInteger(n)) throw new DerError(`${what} too large`);
  }
  return n;
}

interface PssDefaults {
  hash: HashName;
  mgf1Hash: HashName;
  saltLength: number;
}

/**
 * Normalize RSASSA-PSS parameters. Absent params, an empty SEQUENCE, and
 * explicit default values all normalize to the same result.
 * Throws DerError on structural violations; returns null on unsupported content.
 */
function normalizePssParams(params: DerElement | null): PssDefaults | null {
  const result: PssDefaults = { hash: "SHA-1", mgf1Hash: "SHA-1", saltLength: 20 };
  if (params === null) return result;
  if (params.tag !== TAG.SEQUENCE) {
    throw new DerError("RSASSA-PSS params must be a SEQUENCE");
  }
  let lastTag = 0x9f;
  for (const field of params.children) {
    if (field.tag <= lastTag || field.tag > 0xa3) {
      throw new DerError("RSASSA-PSS params out of order or unexpected tag");
    }
    if (field.children.length !== 1) {
      throw new DerError("RSASSA-PSS explicit field must wrap exactly one value");
    }
    const inner = field.children[0];
    switch (field.tag) {
      case 0xa0: {
        const hash = normalizeHashAlgorithm(inner);
        if (hash === null) return null;
        result.hash = hash;
        break;
      }
      case 0xa1: {
        if (
          inner.tag !== TAG.SEQUENCE ||
          inner.children.length !== 2 ||
          inner.children[0].tag !== TAG.OID
        ) {
          throw new DerError("malformed MaskGenAlgorithmIdentifier");
        }
        if (oidOf(inner) !== OID.mgf1) return null;
        const mgfHash = normalizeHashAlgorithm(inner.children[1]);
        if (mgfHash === null) return null;
        result.mgf1Hash = mgfHash;
        break;
      }
      case 0xa2: {
        result.saltLength = decodeUnsignedInteger(inner, "saltLength");
        break;
      }
      case 0xa3: {
        const trailer = decodeUnsignedInteger(inner, "trailerField");
        if (trailer !== 1) return null;
        break;
      }
    }
    lastTag = field.tag;
  }
  return result;
}

/**
 * Normalize an AlgorithmIdentifier. Returns kind "unknown" (keeping the raw
 * encoding for inner/outer comparison) for unrecognized OIDs or unsupported
 * parameters. Throws DerError on structural violations.
 */
export function normalizeSignatureAlgorithm(
  algorithm: DerElement
): NormalizedSignature {
  const oid = oidOf(algorithm);
  const params = paramsOf(algorithm);
  const rsaHash = RSA_HASH_BY_OID[oid];
  if (rsaHash !== undefined) {
    if (isNullOrAbsent(params)) return { kind: "rsa", hash: rsaHash };
    return { kind: "unknown", raw: algorithm.raw };
  }
  if (oid === OID.rsassaPss) {
    const pss = normalizePssParams(params);
    if (pss === null) return { kind: "unknown", raw: algorithm.raw };
    return { kind: "rsassa-pss", ...pss };
  }
  return { kind: "unknown", raw: algorithm.raw };
}

/** Deep equality on normalized signature algorithms. */
export function normalizedEqual(a: NormalizedSignature, b: NormalizedSignature): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "rsa":
      return a.hash === (b as { hash: HashName }).hash;
    case "rsassa-pss": {
      const other = b as { hash: HashName; mgf1Hash: HashName; saltLength: number };
      return (
        a.hash === other.hash &&
        a.mgf1Hash === other.mgf1Hash &&
        a.saltLength === other.saltLength
      );
    }
    case "unknown":
      return bytesEqual(a.raw, (b as { raw: Uint8Array }).raw);
  }
}
