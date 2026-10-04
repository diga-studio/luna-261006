import {
  bitString,
  explicit,
  integer,
  nullParams,
  octetString,
  oid,
  seq,
  setOf,
  utcTime,
  utf8String,
} from './der-writer';

export const OID = {
  sha1WithRSA: '1.2.840.113549.1.1.5',
  sha256WithRSA: '1.2.840.113549.1.1.11',
  sha384WithRSA: '1.2.840.113549.1.1.12',
  sha512WithRSA: '1.2.840.113549.1.1.13',
  rsassaPss: '1.2.840.113549.1.1.10',
  mgf1: '1.2.840.113549.1.1.8',
  rsaEncryption: '1.2.840.113549.1.1.1',
  sha1: '1.3.14.3.2.26',
  sha256: '2.16.840.1.101.3.4.2.1',
  sha384: '2.16.840.1.101.3.4.2.2',
  sha512: '2.16.840.1.101.3.4.2.3',
  ecPublicKey: '1.2.840.10045.2.1',
} as const;

/** AlgorithmIdentifier for a classic RSA signature; params: 'null' | 'absent'. */
export function rsaSigAlg(oidText: string, params: 'null' | 'absent' = 'null'): Uint8Array {
  return params === 'null' ? seq(oid(oidText), nullParams()) : seq(oid(oidText));
}

/** AlgorithmIdentifier for a hash; params: 'null' | 'absent'. */
export function hashAlg(oidText: string, params: 'null' | 'absent' = 'null'): Uint8Array {
  return params === 'null' ? seq(oid(oidText), nullParams()) : seq(oid(oidText));
}

export interface PssParamSpec {
  hash?: Uint8Array;
  mgf?: Uint8Array;
  saltLength?: number;
  trailerField?: number;
}

/** RSASSA-PSS-params SEQUENCE built from explicit tags 0..3. */
export function pssParams(spec: PssParamSpec): Uint8Array {
  const fields: Uint8Array[] = [];
  if (spec.hash !== undefined) fields.push(explicit(0, spec.hash));
  if (spec.mgf !== undefined) fields.push(explicit(1, spec.mgf));
  if (spec.saltLength !== undefined) fields.push(explicit(2, integer(spec.saltLength)));
  if (spec.trailerField !== undefined) fields.push(explicit(3, integer(spec.trailerField)));
  return seq(...fields);
}

/** MaskGenAlgorithm AlgorithmIdentifier: MGF1 with a hash identifier. */
export function mgf1Alg(hashAlgId: Uint8Array): Uint8Array {
  return seq(oid(OID.mgf1), hashAlgId);
}

/** RSASSA-PSS AlgorithmIdentifier; params=null means parameters are absent. */
export function pssAlg(params: Uint8Array | null): Uint8Array {
  return params === null ? seq(oid(OID.rsassaPss)) : seq(oid(OID.rsassaPss), params);
}

export interface CertSpec {
  innerSig: Uint8Array;
  outerSig: Uint8Array;
  /** Include [0] EXPLICIT version in the TBS (default true). */
  withVersion?: boolean;
  /** OID used inside the subjectPublicKeyInfo algorithm. */
  spkiOid?: string;
  /** Extra TBS fields appended after the SPKI (e.g. extensions). */
  extraTbs?: Uint8Array[];
}

const DUMMY_NAME = seq(
  setOf(seq(oid('2.5.4.3'), utf8String('review-fixture'))),
);

const VALIDITY = seq(utcTime('240101000000Z'), utcTime('340101000000Z'));

/**
 * Build a structurally plausible DER certificate. The signature value and
 * public key are dummy bytes; only the fields under review are meaningful.
 */
export function buildCertificate(spec: CertSpec): Uint8Array {
  const withVersion = spec.withVersion ?? true;
  const spki = seq(
    seq(oid(spec.spkiOid ?? OID.rsaEncryption), nullParams()),
    bitString(new Uint8Array([1, 2, 3, 4])),
  );
  const tbsFields: Uint8Array[] = [];
  if (withVersion) tbsFields.push(explicit(0, integer(2)));
  tbsFields.push(
    integer(0x1234),
    spec.innerSig,
    DUMMY_NAME,
    VALIDITY,
    DUMMY_NAME,
    spki,
  );
  if (spec.extraTbs !== undefined) tbsFields.push(...spec.extraTbs);
  return seq(
    seq(...tbsFields),
    spec.outerSig,
    bitString(new Uint8Array([9, 9, 9])),
  );
}

/** Extensions field ([3] EXPLICIT) whose values embed the given raw bytes. */
export function extensionsWith(rawValues: Uint8Array[]): Uint8Array {
  const extensions = rawValues.map((value, index) =>
    seq(oid(`1.3.6.1.4.1.99999.${index + 1}`), octetString(value)),
  );
  return explicit(3, seq(...extensions));
}
