/** Local DER builders for certificate fixtures. No external dependencies. */

import { OID } from "../src/oids";

export function tlv(tag: number, value: Uint8Array): Uint8Array {
  const len = value.length;
  let header: number[];
  if (len < 0x80) {
    header = [tag, len];
  } else if (len < 0x100) {
    header = [tag, 0x81, len];
  } else {
    header = [tag, 0x82, len >> 8, len & 0xff];
  }
  const out = new Uint8Array(header.length + value.length);
  out.set(header, 0);
  out.set(value, header.length);
  return out;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export const seq = (...children: Uint8Array[]) => tlv(0x30, concat(...children));
export const set = (...children: Uint8Array[]) => tlv(0x31, concat(...children));
export const explicit = (n: number, child: Uint8Array) => tlv(0xa0 + n, child);
export const null_ = () => tlv(0x05, new Uint8Array(0));
export const integer = (n: number) => {
  const bytes: number[] = [];
  let v = n;
  do {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  } while (v > 0);
  if (bytes[0] & 0x80) bytes.unshift(0);
  return tlv(0x02, new Uint8Array(bytes));
};
export const bitString = (payload: Uint8Array) =>
  tlv(0x03, concat(new Uint8Array([0]), payload));
export const octetString = (payload: Uint8Array) => tlv(0x04, payload);
export const utcTime = (s: string) =>
  tlv(0x17, new TextEncoder().encode(s));
export const utf8String = (s: string) =>
  tlv(0x0c, new TextEncoder().encode(s));

export function oid(dotted: string): Uint8Array {
  const arcs = dotted.split(".").map(Number);
  const body: number[] = [arcs[0] * 40 + arcs[1]];
  for (const arc of arcs.slice(2)) {
    const stack: number[] = [arc & 0x7f];
    let v = Math.floor(arc / 128);
    while (v > 0) {
      stack.unshift(0x80 | (v & 0x7f));
      v = Math.floor(v / 128);
    }
    body.push(...stack);
  }
  return tlv(0x06, new Uint8Array(body));
}

export const algId = (oidDotted: string, params?: Uint8Array) =>
  params === undefined ? seq(oid(oidDotted)) : seq(oid(oidDotted), params);

export interface CertOptions {
  /** Include the [0] EXPLICIT version field in the TBS. */
  withVersion?: boolean;
  innerSignature: Uint8Array;
  outerSignature?: Uint8Array; // defaults to innerSignature
  /** Extra TBS fields appended after subjectPublicKeyInfo (e.g. extensions). */
  extraTbsFields?: Uint8Array[];
  /** AlgorithmIdentifier placed inside subjectPublicKeyInfo. */
  spkiAlgorithm?: Uint8Array;
}

/** Build a structurally plausible DER certificate for signature review. */
export function buildCertificate(opts: CertOptions): Uint8Array {
  const tbsFields: Uint8Array[] = [];
  if (opts.withVersion) tbsFields.push(explicit(0, integer(2)));
  tbsFields.push(
    integer(1), // serialNumber
    opts.innerSignature, // signature
    seq(), // issuer (empty RDNSequence)
    seq(utcTime("260101000000Z"), utcTime("261231235959Z")), // validity
    seq(), // subject
    seq(
      opts.spkiAlgorithm ?? algId(OID.sha256WithRSAEncryption, null_()),
      bitString(new Uint8Array([1, 2, 3]))
    ) // spki
  );
  if (opts.extraTbsFields) tbsFields.push(...opts.extraTbsFields);
  return seq(
    seq(...tbsFields),
    opts.outerSignature ?? opts.innerSignature,
    bitString(new Uint8Array([0xde, 0xad]))
  );
}
