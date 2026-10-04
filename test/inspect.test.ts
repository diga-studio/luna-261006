import { test } from "node:test";
import assert from "node:assert/strict";
import { inspectCertificate, inspectChain } from "../src/inspect";
import { OID } from "../src/oids";
import {
  algId,
  buildCertificate,
  explicit,
  integer,
  null_,
  octetString,
  oid,
  seq,
  tlv,
  utf8String,
} from "./fixtures";

const rsa = (hashOid: string, params?: Uint8Array) => algId(hashOid, params);

const pssParams = (...fields: Uint8Array[]) => seq(...fields);
const pssHash = (hashOid: string) => explicit(0, algId(hashOid, null_()));
const pssMgf1 = (hashOid: string) =>
  explicit(1, algId(OID.mgf1, algId(hashOid, null_())));
const pssSalt = (n: number) => explicit(2, integer(n));
const pssTrailer = (n: number) => explicit(3, integer(n));
const pss = (...fields: Uint8Array[]) => algId(OID.rsassaPss, pssParams(...fields));

test("sha256WithRSA with NULL params is SAFE", () => {
  const cert = buildCertificate({ innerSignature: rsa(OID.sha256WithRSAEncryption, null_()) });
  assert.equal(inspectCertificate(cert), "SAFE");
});

test("sha384/sha512WithRSA are SAFE", () => {
  for (const hashOid of [OID.sha384WithRSAEncryption, OID.sha512WithRSAEncryption]) {
    const cert = buildCertificate({ innerSignature: rsa(hashOid, null_()) });
    assert.equal(inspectCertificate(cert), "SAFE");
  }
});

test("sha1WithRSA is WEAK", () => {
  const cert = buildCertificate({ innerSignature: rsa(OID.sha1WithRSAEncryption, null_()) });
  assert.equal(inspectCertificate(cert), "WEAK");
});

test("NULL params and absent params are equivalent", () => {
  const cert = buildCertificate({
    innerSignature: rsa(OID.sha256WithRSAEncryption, null_()),
    outerSignature: rsa(OID.sha256WithRSAEncryption),
  });
  assert.equal(inspectCertificate(cert), "SAFE");
});

test("TBS without version field is handled", () => {
  const cert = buildCertificate({
    withVersion: false,
    innerSignature: rsa(OID.sha256WithRSAEncryption, null_()),
  });
  assert.equal(inspectCertificate(cert), "SAFE");
});

test("TBS with version field is handled", () => {
  const cert = buildCertificate({
    withVersion: true,
    innerSignature: rsa(OID.sha256WithRSAEncryption, null_()),
  });
  assert.equal(inspectCertificate(cert), "SAFE");
});

test("inner/outer algorithm mismatch is INVALID", () => {
  const cert = buildCertificate({
    innerSignature: rsa(OID.sha256WithRSAEncryption, null_()),
    outerSignature: rsa(OID.sha384WithRSAEncryption, null_()),
  });
  assert.equal(inspectCertificate(cert), "INVALID");
});

test("unknown signature OID is UNKNOWN", () => {
  const cert = buildCertificate({ innerSignature: algId("1.2.3.4.5", null_()) });
  assert.equal(inspectCertificate(cert), "UNKNOWN");
});

test("unknown OID: identical raw in/out is UNKNOWN, differing raw is INVALID", () => {
  const same = buildCertificate({ innerSignature: algId("1.2.3.4.5", null_()) });
  assert.equal(inspectCertificate(same), "UNKNOWN");
  const differing = buildCertificate({
    innerSignature: algId("1.2.3.4.5", null_()),
    outerSignature: algId("1.2.3.4.5"),
  });
  assert.equal(inspectCertificate(differing), "INVALID");
});

test("supported RSA OID with unsupported params is UNKNOWN", () => {
  const weird = rsa(OID.sha256WithRSAEncryption, octetString(new Uint8Array([1])));
  const cert = buildCertificate({ innerSignature: weird });
  assert.equal(inspectCertificate(cert), "UNKNOWN");
});

test("PSS with empty SEQUENCE equals explicit defaults and is WEAK", () => {
  const emptyParams = algId(OID.rsassaPss, pssParams());
  const explicitDefaults = pss(
    pssHash(OID.sha1),
    pssMgf1(OID.sha1),
    pssSalt(20),
    pssTrailer(1)
  );
  const certEmpty = buildCertificate({ innerSignature: emptyParams });
  assert.equal(inspectCertificate(certEmpty), "WEAK");
  const certExplicit = buildCertificate({ innerSignature: explicitDefaults });
  assert.equal(inspectCertificate(certExplicit), "WEAK");
  const mixed = buildCertificate({
    innerSignature: explicitDefaults,
    outerSignature: emptyParams,
  });
  assert.equal(inspectCertificate(mixed), "WEAK");
});

test("PSS with absent params uses defaults and is WEAK", () => {
  const cert = buildCertificate({ innerSignature: algId(OID.rsassaPss) });
  assert.equal(inspectCertificate(cert), "WEAK");
});

test("PSS SHA-256 main hash with omitted maskGenAlgorithm is WEAK", () => {
  const cert = buildCertificate({ innerSignature: pss(pssHash(OID.sha256)) });
  assert.equal(inspectCertificate(cert), "WEAK");
});

test("PSS SHA-256 with MGF1(SHA-256) is SAFE", () => {
  const cert = buildCertificate({
    innerSignature: pss(pssHash(OID.sha256), pssMgf1(OID.sha256), pssSalt(32)),
  });
  assert.equal(inspectCertificate(cert), "SAFE");
});

test("PSS SHA-384 with MGF1(SHA-512) is SAFE", () => {
  const cert = buildCertificate({
    innerSignature: pss(pssHash(OID.sha384), pssMgf1(OID.sha512), pssSalt(48), pssTrailer(1)),
  });
  assert.equal(inspectCertificate(cert), "SAFE");
});

test("PSS with SHA-1 only in MGF1 is WEAK", () => {
  const cert = buildCertificate({
    innerSignature: pss(pssHash(OID.sha512), pssMgf1(OID.sha1)),
  });
  assert.equal(inspectCertificate(cert), "WEAK");
});

test("PSS params must be a SEQUENCE", () => {
  const bad = algId(OID.rsassaPss, integer(5));
  const cert = buildCertificate({ innerSignature: bad });
  assert.equal(inspectCertificate(cert), "INVALID");
});

test("PSS fields out of order are INVALID", () => {
  const bad = pss(pssMgf1(OID.sha256), pssHash(OID.sha256));
  const cert = buildCertificate({ innerSignature: bad });
  assert.equal(inspectCertificate(cert), "INVALID");
});

test("PSS with unknown MGF OID is UNKNOWN", () => {
  const bad = pss(pssHash(OID.sha256), explicit(1, algId("1.2.3.4", null_())));
  const cert = buildCertificate({ innerSignature: bad });
  assert.equal(inspectCertificate(cert), "UNKNOWN");
});

test("PSS with trailerField other than 1 is UNKNOWN", () => {
  const bad = pss(pssHash(OID.sha256), pssMgf1(OID.sha256), pssTrailer(2));
  const cert = buildCertificate({ innerSignature: bad });
  assert.equal(inspectCertificate(cert), "UNKNOWN");
});

test("PSS with unknown hash OID is UNKNOWN", () => {
  const bad = pss(pssHash("1.2.3.4.5"));
  const cert = buildCertificate({ innerSignature: bad });
  assert.equal(inspectCertificate(cert), "UNKNOWN");
});

test("SHA-1 OID bytes inside an extension do not pollute a SHA-256 signature", () => {
  const extension = seq(
    oid("2.5.29.99"),
    octetString(concatBytes(oid(OID.sha1), utf8String("sha1WithRSAEncryption 1.2.840.113549.1.1.5")))
  );
  const extensions = explicit(3, seq(extension));
  const cert = buildCertificate({
    withVersion: true,
    innerSignature: rsa(OID.sha256WithRSAEncryption, null_()),
    extraTbsFields: [extensions],
  });
  assert.equal(inspectCertificate(cert), "SAFE");
});

test("SHA-1 OID inside the public key algorithm does not pollute the verdict", () => {
  const cert = buildCertificate({
    innerSignature: rsa(OID.sha256WithRSAEncryption, null_()),
    spkiAlgorithm: algId(OID.sha1WithRSAEncryption, null_()),
  });
  assert.equal(inspectCertificate(cert), "SAFE");
});

test("PSS hash AlgorithmIdentifier: NULL and absent params are equivalent", () => {
  const inner = pss(explicit(0, algId(OID.sha256, null_())), pssMgf1(OID.sha256));
  const outer = pss(explicit(0, algId(OID.sha256)), pssMgf1(OID.sha256));
  const cert = buildCertificate({ innerSignature: inner, outerSignature: outer });
  assert.equal(inspectCertificate(cert), "SAFE");
});

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

test("malformed DER is INVALID", () => {
  assert.equal(inspectCertificate(new Uint8Array([0x30, 0x03, 0x02, 0x01])), "INVALID");
  assert.equal(inspectCertificate(new Uint8Array([])), "INVALID");
  assert.equal(inspectCertificate(tlv(0x04, new Uint8Array([1]))), "INVALID");
});

test("inspectChain is true only when every certificate is SAFE", () => {
  const safe1 = buildCertificate({ innerSignature: rsa(OID.sha256WithRSAEncryption, null_()) });
  const safe2 = buildCertificate({
    innerSignature: pss(pssHash(OID.sha256), pssMgf1(OID.sha256)),
  });
  const weak = buildCertificate({ innerSignature: rsa(OID.sha1WithRSAEncryption, null_()) });
  const unknown = buildCertificate({ innerSignature: algId("1.2.3.4.5") });
  assert.equal(inspectChain([safe1, safe2]), true);
  assert.equal(inspectChain([safe1, weak]), false);
  assert.equal(inspectChain([safe1, unknown]), false);
  assert.equal(inspectChain([]), true);
});
