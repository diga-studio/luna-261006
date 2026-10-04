import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectCertificate, inspectChain } from '../src/index';
import { integer, nullParams, octetString, oid, seq } from './der-writer';
import {
  OID,
  buildCertificate,
  extensionsWith,
  hashAlg,
  mgf1Alg,
  pssAlg,
  pssParams,
  rsaSigAlg,
} from './fixtures';

function cert(innerSig: Uint8Array, outerSig?: Uint8Array, extra?: Partial<Parameters<typeof buildCertificate>[0]>): Uint8Array {
  return buildCertificate({ innerSig, outerSig: outerSig ?? innerSig, ...extra });
}

test('RSA signatures: each supported hash reviews correctly', () => {
  assert.equal(inspectCertificate(cert(rsaSigAlg(OID.sha1WithRSA))), 'WEAK');
  assert.equal(inspectCertificate(cert(rsaSigAlg(OID.sha256WithRSA))), 'SAFE');
  assert.equal(inspectCertificate(cert(rsaSigAlg(OID.sha384WithRSA))), 'SAFE');
  assert.equal(inspectCertificate(cert(rsaSigAlg(OID.sha512WithRSA))), 'SAFE');
});

test('NULL parameters and absent parameters are equivalent', () => {
  const inner = rsaSigAlg(OID.sha256WithRSA, 'null');
  const outer = rsaSigAlg(OID.sha256WithRSA, 'absent');
  assert.equal(inspectCertificate(cert(inner, outer)), 'SAFE');
  assert.equal(inspectCertificate(cert(outer, inner)), 'SAFE');
});

test('TBS without a version field is accepted', () => {
  const sig = rsaSigAlg(OID.sha256WithRSA);
  assert.equal(inspectCertificate(cert(sig, sig, { withVersion: false })), 'SAFE');
  const weak = rsaSigAlg(OID.sha1WithRSA);
  assert.equal(inspectCertificate(cert(weak, weak, { withVersion: false })), 'WEAK');
});

test('inner/outer mismatch after normalization is INVALID', () => {
  assert.equal(
    inspectCertificate(cert(rsaSigAlg(OID.sha256WithRSA), rsaSigAlg(OID.sha384WithRSA))),
    'INVALID',
  );
  assert.equal(
    inspectCertificate(cert(rsaSigAlg(OID.sha256WithRSA), pssAlg(null))),
    'INVALID',
  );
});

test('PSS: empty SEQUENCE equals explicit defaults, both WEAK', () => {
  const emptySeq = pssAlg(pssParams({}));
  const explicitDefaults = pssAlg(
    pssParams({
      hash: hashAlg(OID.sha1),
      mgf: mgf1Alg(hashAlg(OID.sha1)),
      saltLength: 20,
      trailerField: 1,
    }),
  );
  assert.equal(inspectCertificate(cert(emptySeq)), 'WEAK');
  assert.equal(inspectCertificate(cert(explicitDefaults)), 'WEAK');
  assert.equal(inspectCertificate(cert(emptySeq, explicitDefaults)), 'WEAK');
  assert.equal(inspectCertificate(cert(explicitDefaults, emptySeq)), 'WEAK');
  assert.equal(inspectCertificate(cert(pssAlg(null), emptySeq)), 'WEAK');
});

test('PSS: SHA-256 main hash with omitted maskGenAlgorithm is still WEAK', () => {
  const sig = pssAlg(pssParams({ hash: hashAlg(OID.sha256) }));
  assert.equal(inspectCertificate(cert(sig)), 'WEAK');
});

test('PSS: SHA-256 with MGF1(SHA-256) is SAFE, explicit MGF1(SHA-1) is WEAK', () => {
  const safe = pssAlg(
    pssParams({
      hash: hashAlg(OID.sha256),
      mgf: mgf1Alg(hashAlg(OID.sha256)),
      saltLength: 32,
    }),
  );
  assert.equal(inspectCertificate(cert(safe)), 'SAFE');
  const weak = pssAlg(
    pssParams({
      hash: hashAlg(OID.sha256),
      mgf: mgf1Alg(hashAlg(OID.sha1)),
    }),
  );
  assert.equal(inspectCertificate(cert(weak)), 'WEAK');
});

test('PSS: explicit defaults on one side match omitted fields on the other', () => {
  const minimal = pssAlg(pssParams({ hash: hashAlg(OID.sha256) }));
  const explicit_ = pssAlg(
    pssParams({
      hash: hashAlg(OID.sha256),
      mgf: mgf1Alg(hashAlg(OID.sha1)),
      saltLength: 20,
      trailerField: 1,
    }),
  );
  assert.equal(inspectCertificate(cert(minimal, explicit_)), 'WEAK');
});

test('PSS: differing recognized parameters are INVALID', () => {
  const salt20 = pssAlg(pssParams({ hash: hashAlg(OID.sha256), mgf: mgf1Alg(hashAlg(OID.sha256)) }));
  const salt32 = pssAlg(
    pssParams({ hash: hashAlg(OID.sha256), mgf: mgf1Alg(hashAlg(OID.sha256)), saltLength: 32 }),
  );
  assert.equal(inspectCertificate(cert(salt20, salt32)), 'INVALID');
});

test('unsupported trailerField is UNKNOWN, not INVALID', () => {
  const sig = pssAlg(pssParams({ trailerField: 2 }));
  assert.equal(inspectCertificate(cert(sig)), 'UNKNOWN');
});

test('unknown signature OID is UNKNOWN when encodings match', () => {
  const sig = seq(oid('1.2.3.4.5'), nullParams());
  assert.equal(inspectCertificate(cert(sig)), 'UNKNOWN');
});

test('unknown OID: NULL vs absent parameters differ in raw encoding', () => {
  const withNull = seq(oid('1.2.3.4.5'), nullParams());
  const absent = seq(oid('1.2.3.4.5'));
  assert.equal(inspectCertificate(cert(withNull, absent)), 'INVALID');
});

test('unsupported parameter on a supported OID is UNKNOWN', () => {
  const weirdParam = seq(oid(OID.sha256WithRSA), integer(7));
  assert.equal(inspectCertificate(cert(weirdParam)), 'UNKNOWN');
  // and INVALID when the other side uses the normal NULL form
  assert.equal(inspectCertificate(cert(weirdParam, rsaSigAlg(OID.sha256WithRSA))), 'INVALID');
});

test('SHA-1 OID bytes inside extensions do not pollute a SHA-256 signature', () => {
  const sig = rsaSigAlg(OID.sha256WithRSA);
  const sha1Evidence = seq(
    oid(OID.sha1),
    oid(OID.sha1WithRSA),
    octetString(oid(OID.sha1)),
  );
  const certWithExtensions = cert(sig, sig, {
    extraTbs: [extensionsWith([sha1Evidence, oid(OID.sha1)])],
  });
  assert.equal(inspectCertificate(certWithExtensions), 'SAFE');
});

test('SHA-1 OID used as the SPKI algorithm does not pollute the verdict', () => {
  const sig = rsaSigAlg(OID.sha256WithRSA);
  assert.equal(inspectCertificate(cert(sig, sig, { spkiOid: OID.sha1 })), 'SAFE');
});

test('structurally broken input is INVALID', () => {
  assert.equal(inspectCertificate(new Uint8Array([])), 'INVALID');
  assert.equal(inspectCertificate(new Uint8Array([0x30, 0x03, 0x02, 0x01])), 'INVALID');
  assert.equal(inspectCertificate(new Uint8Array([0x05, 0x00])), 'INVALID');
  assert.equal(inspectCertificate(seq(integer(1), integer(2), integer(3))), 'INVALID');
});

test('inspectChain reports true only when every certificate is SAFE', () => {
  const safe = cert(rsaSigAlg(OID.sha256WithRSA));
  const safePss = cert(
    pssAlg(pssParams({ hash: hashAlg(OID.sha384), mgf: mgf1Alg(hashAlg(OID.sha384)) })),
  );
  const weak = cert(rsaSigAlg(OID.sha1WithRSA));
  const unknown = cert(seq(oid('1.2.3.4.5')));
  const invalid = cert(rsaSigAlg(OID.sha256WithRSA), rsaSigAlg(OID.sha512WithRSA));

  assert.equal(inspectChain([safe, safePss]), true);
  assert.equal(inspectChain([]), true);
  assert.equal(inspectChain([safe, weak]), false);
  assert.equal(inspectChain([safe, unknown]), false);
  assert.equal(inspectChain([safe, invalid]), false);
});
