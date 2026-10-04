import { DerNode, decodeOid, isSequence } from './der';

export type HashName = 'sha1' | 'sha256' | 'sha384' | 'sha512';

export type SignatureDescription =
  | { kind: 'rsa'; hash: HashName }
  | {
      kind: 'pss';
      hash: HashName;
      mgfHash: HashName;
      saltLength: number;
      trailerField: number;
    };

export interface NormalizedAlgorithm {
  /** Full DER encoding of the AlgorithmIdentifier, kept for raw comparison. */
  raw: Uint8Array;
  /** Present only when the algorithm and all parameters are fully recognized. */
  desc: SignatureDescription | null;
}

const HASH_OIDS: ReadonlyMap<string, HashName> = new Map([
  ['1.3.14.3.2.26', 'sha1'],
  ['2.16.840.1.101.3.4.2.1', 'sha256'],
  ['2.16.840.1.101.3.4.2.2', 'sha384'],
  ['2.16.840.1.101.3.4.2.3', 'sha512'],
]);

const RSA_SIGNATURE_OIDS: ReadonlyMap<string, HashName> = new Map([
  ['1.2.840.113549.1.1.5', 'sha1'],
  ['1.2.840.113549.1.1.11', 'sha256'],
  ['1.2.840.113549.1.1.12', 'sha384'],
  ['1.2.840.113549.1.1.13', 'sha512'],
]);

const OID_RSASSA_PSS = '1.2.840.113549.1.1.10';
const OID_MGF1 = '1.2.840.113549.1.1.8';

const PSS_DEFAULTS = { hash: 'sha1', mgfHash: 'sha1', saltLength: 20, trailerField: 1 } as const;

function isNull(node: DerNode): boolean {
  return node.tagClass === 0 && !node.constructed && node.tagNumber === 5 && node.value.length === 0;
}

function isInteger(node: DerNode): boolean {
  return node.tagClass === 0 && !node.constructed && node.tagNumber === 2;
}

function integerValue(node: DerNode): number | null {
  if (!isInteger(node) || node.value.length === 0 || node.value.length > 4) return null;
  let value = 0;
  for (const byte of node.value) value = value * 256 + byte;
  return value;
}

/** Split an AlgorithmIdentifier into its OID text and optional parameter node. */
function splitAlgorithmIdentifier(node: DerNode): { oid: string; params: DerNode | null } | null {
  if (!isSequence(node) || node.children === null) return null;
  const count = node.children.length;
  if (count < 1 || count > 2) return null;
  const oidNode = node.children[0]!;
  let oid: string;
  try {
    oid = decodeOid(oidNode);
  } catch {
    return null;
  }
  return { oid, params: count === 2 ? node.children[1]! : null };
}

/**
 * Recognized hash AlgorithmIdentifier (NULL or absent parameters only),
 * or null when anything is unsupported.
 */
function recognizeHashAlgorithm(node: DerNode): HashName | null {
  const split = splitAlgorithmIdentifier(node);
  if (split === null) return null;
  const hash = HASH_OIDS.get(split.oid);
  if (hash === undefined) return null;
  if (split.params !== null && !isNull(split.params)) return null;
  return hash;
}

/** Parse an RSASSA-PSS-params SEQUENCE, filling defaults. Null when unsupported. */
function parsePssParams(params: DerNode): SignatureDescription | null {
  if (!isSequence(params) || params.children === null) return null;

  let hash: HashName = PSS_DEFAULTS.hash;
  let mgfHash: HashName = PSS_DEFAULTS.mgfHash;
  let saltLength: number = PSS_DEFAULTS.saltLength;
  let trailerField: number = PSS_DEFAULTS.trailerField;

  let nextTag = 0;
  for (const field of params.children) {
    if (field.tagClass !== 2 || !field.constructed) return null;
    if (field.tagNumber < nextTag || field.tagNumber > 3) return null;
    if (field.children === null || field.children.length !== 1) return null;
    const inner = field.children[0]!;
    switch (field.tagNumber) {
      case 0: {
        const recognized = recognizeHashAlgorithm(inner);
        if (recognized === null) return null;
        hash = recognized;
        break;
      }
      case 1: {
        const split = splitAlgorithmIdentifier(inner);
        if (split === null || split.oid !== OID_MGF1 || split.params === null) return null;
        const recognized = recognizeHashAlgorithm(split.params);
        if (recognized === null) return null;
        mgfHash = recognized;
        break;
      }
      case 2: {
        const value = integerValue(inner);
        if (value === null) return null;
        saltLength = value;
        break;
      }
      case 3: {
        const value = integerValue(inner);
        if (value === null || value !== 1) return null;
        trailerField = value;
        break;
      }
      default:
        return null;
    }
    nextTag = field.tagNumber + 1;
  }

  return { kind: 'pss', hash, mgfHash, saltLength, trailerField };
}

/**
 * Normalize a signature AlgorithmIdentifier. NULL vs absent parameters are
 * collapsed for supported RSA signatures and hash identifiers; unknown OIDs
 * or unsupported parameters yield desc=null with only the raw encoding kept.
 */
export function normalizeSignatureAlgorithm(node: DerNode): NormalizedAlgorithm {
  const raw = node.raw;
  const split = splitAlgorithmIdentifier(node);
  if (split === null) return { raw, desc: null };

  const rsaHash = RSA_SIGNATURE_OIDS.get(split.oid);
  if (rsaHash !== undefined) {
    if (split.params === null || isNull(split.params)) {
      return { raw, desc: { kind: 'rsa', hash: rsaHash } };
    }
    return { raw, desc: null };
  }

  if (split.oid === OID_RSASSA_PSS) {
    if (split.params === null) {
      return { raw, desc: { kind: 'pss', ...PSS_DEFAULTS } };
    }
    const desc = parsePssParams(split.params);
    return { raw, desc };
  }

  return { raw, desc: null };
}

/** Deep equality for two recognized signature descriptions. */
export function descriptionsEqual(a: SignatureDescription, b: SignatureDescription): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'rsa' && b.kind === 'rsa') return a.hash === b.hash;
  if (a.kind === 'pss' && b.kind === 'pss') {
    return (
      a.hash === b.hash &&
      a.mgfHash === b.mgfHash &&
      a.saltLength === b.saltLength &&
      a.trailerField === b.trailerField
    );
  }
  return false;
}
