import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { verifyAuthnRequest, type VerifyResult } from '../src/index.js';
import {
  GATEWAY_DESTINATION,
  keyInfoXml,
  makeApp,
  signRequest,
  trustedDir,
} from './helpers.js';

const APP_ENTITY = 'https://app.example.com/saml';
const CALLBACK_A = 'https://app.example.com/callback-a';
const CALLBACK_B = 'https://app.example.com/callback-b';
const ATTACKER_CALLBACK = 'https://evil.example.com/steal';

const app = makeApp(APP_ENTITY, [CALLBACK_A, CALLBACK_B]);
const directory = trustedDir([app]);

function requestXml(fields: {
  id: string;
  acsUrl: string;
  destination?: string;
  issuer?: string;
  inner?: string;
  extraRootAttrs?: string;
}): string {
  return (
    `<AuthnRequest xmlns="urn:oasis:names:tc:SAML:2.0:protocol"` +
    ` ID="${fields.id}" Version="2.0"` +
    ` Destination="${fields.destination ?? GATEWAY_DESTINATION}"` +
    ` AssertionConsumerServiceURL="${fields.acsUrl}"` +
    (fields.extraRootAttrs ?? '') +
    `>` +
    `<Issuer xmlns="urn:oasis:names:tc:SAML:2.0:assertion">${fields.issuer ?? APP_ENTITY}</Issuer>` +
    (fields.inner ?? '') +
    `</AuthnRequest>`
  );
}

function verify(xml: string): VerifyResult {
  return verifyAuthnRequest({
    xml,
    trustedApps: directory,
    destination: GATEWAY_DESTINATION,
  });
}

function expectRejected(result: VerifyResult, reasonIncludes: string): void {
  assert.ok(!result.ok, `expected rejection, got ok result: ${JSON.stringify(result)}`);
  assert.ok(
    result.reason.includes(reasonIncludes),
    `reason ${JSON.stringify(result.reason)} should include ${JSON.stringify(reasonIncludes)}`,
  );
  // 拒绝时不得携带任何可供登录使用的字段。
  assert.equal('id' in result, false);
  assert.equal('entityId' in result, false);
  assert.equal('assertionConsumerServiceUrl' in result, false);
}

function signedRequest(id: string, acsUrl: string): string {
  return signRequest(requestXml({ id, acsUrl }), { privateKey: app.privateKey });
}

describe('wrapper attacks', () => {
  it('rejects outer request when only a nested request is signed', () => {
    // 嵌套请求带有合法签名，保护回调 A；外层未签名，携带另一回调 B。
    const nestedSigned = signRequest(
      requestXml({ id: '_nested-req', acsUrl: CALLBACK_A }),
      { privateKey: app.privateKey },
    );
    const outer = requestXml({
      id: '_outer-req',
      acsUrl: CALLBACK_B,
      inner: `<Extensions>${nestedSigned}</Extensions>`,
    });
    const result = verify(outer);
    expectRejected(result, 'direct child');
  });

  it('rejects signature moved to root but referencing the nested request', () => {
    // 攻击者把对嵌套子树有效的签名提升到外层根下，Reference 仍指向嵌套 ID。
    const outer = requestXml({
      id: '_outer-req',
      acsUrl: CALLBACK_B,
      inner:
        `<Extensions>` +
        requestXml({ id: '_nested-req', acsUrl: CALLBACK_A }) +
        `</Extensions>`,
    });
    const crafted = signRequest(outer, {
      privateKey: app.privateKey,
      referenceUri: '#_nested-req',
      digestTargetId: '_nested-req',
    });
    const result = verify(crafted);
    expectRejected(result, 'Reference URI');
  });
});

describe('content tampering', () => {
  it('rejects callback tampered to another listed URL after signing', () => {
    const signed = signedRequest('_req-tamper', CALLBACK_A);
    const tampered = signed.replace(CALLBACK_A, CALLBACK_B);
    assert.notEqual(tampered, signed);
    expectRejected(verify(tampered), 'digest mismatch');
  });

  it('rejects callback tampered to an attacker URL after signing', () => {
    const signed = signedRequest('_req-tamper2', CALLBACK_A);
    const tampered = signed.replace(CALLBACK_A, ATTACKER_CALLBACK);
    expectRejected(verify(tampered), 'callback list');
  });

  it('rejects a replaced SignatureValue', () => {
    const signed = signedRequest('_req-sigswap', CALLBACK_A);
    const tampered = signed.replace(
      /(<ds:SignatureValue>)[^<]+(<\/ds:SignatureValue>)/,
      '$1AAAA$2',
    );
    assert.notEqual(tampered, signed);
    expectRejected(verify(tampered), 'signature verification failed');
  });
});

describe('duplicate IDs', () => {
  it('rejects a nested element duplicating the root ID', () => {
    const xml = requestXml({
      id: '_dup-id',
      acsUrl: CALLBACK_A,
      inner: '<Extensions ID="_dup-id"></Extensions>',
    });
    const signed = signRequest(xml, { privateKey: app.privateKey });
    expectRejected(verify(signed), 'duplicate ID');
  });

  it('rejects a namespaced id attribute duplicating another ID', () => {
    const xml = requestXml({
      id: '_dup-id-2',
      acsUrl: CALLBACK_A,
      inner:
        '<Extensions xmlns:x="urn:example:x" x:id="_shared">' +
        '<x:item id="_shared"/>' +
        '</Extensions>',
    });
    const signed = signRequest(xml, { privateKey: app.privateKey });
    expectRejected(verify(signed), 'duplicate ID');
  });
});

describe('trust source', () => {
  it('rejects requests signed only by a stranger key carried in KeyInfo', () => {
    const stranger = makeApp('https://stranger.example.com', []);
    const signed = signRequest(requestXml({ id: '_req-keyinfo', acsUrl: CALLBACK_A }), {
      privateKey: stranger.privateKey,
      extraSignatureInnerXml: keyInfoXml(stranger.publicKeyPem),
    });
    // KeyInfo 中的公钥与签名匹配，但它不是受信目录中的密钥。
    expectRejected(verify(signed), 'signature verification failed');
  });

  it('rejects a valid signature from a different trusted app key', () => {
    const other = makeApp('https://other.example.com', [CALLBACK_A]);
    const signed = signRequest(requestXml({ id: '_req-other', acsUrl: CALLBACK_A }), {
      privateKey: other.privateKey,
    });
    expectRejected(verify(signed), 'signature verification failed');
  });
});

describe('structural and input abuse', () => {
  it('rejects malformed XML without throwing', () => {
    const result = verify('<AuthnRequest><Issuer></AuthnRequest>');
    expectRejected(result, 'malformed XML');
  });

  it('rejects DOCTYPE declarations', () => {
    const xml =
      '<!DOCTYPE AuthnRequest [<!ENTITY x "y">]>' +
      requestXml({ id: '_req-dt', acsUrl: CALLBACK_A });
    expectRejected(verify(xml), 'DOCTYPE');
  });

  it('rejects undefined entity references', () => {
    const xml = requestXml({ id: '_req-ent', acsUrl: CALLBACK_A }).replace(
      APP_ENTITY,
      '&undefinedEntity;',
    );
    expectRejected(verify(xml), 'malformed XML');
  });

  it('rejects requests without any Signature', () => {
    expectRejected(
      verify(requestXml({ id: '_req-nosig', acsUrl: CALLBACK_A })),
      'exactly one Signature',
    );
  });

  it('rejects requests with two Signatures', () => {
    const signed = signedRequest('_req-twosig', CALLBACK_A);
    const second = signed.replace(
      '</AuthnRequest>',
      '<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#"></ds:Signature></AuthnRequest>',
    );
    expectRejected(verify(second), 'exactly one Signature');
  });

  it('rejects external Reference URIs', () => {
    const crafted = signRequest(requestXml({ id: '_req-ext', acsUrl: CALLBACK_A }), {
      privateKey: app.privateKey,
      referenceUri: 'https://evil.example.com/external.xml',
    });
    expectRejected(verify(crafted), 'Reference URI');
  });

  it('rejects unsupported signature algorithms', () => {
    const signed = signedRequest('_req-sha1', CALLBACK_A);
    const downgraded = signed.replace(
      'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
      'http://www.w3.org/2000/09/xmldsig#rsa-sha1',
    );
    expectRejected(verify(downgraded), 'unsupported algorithm');
  });

  it('rejects requests exceeding 256 KiB', () => {
    const padding = 'x'.repeat(256 * 1024);
    const xml = requestXml({
      id: '_req-big',
      acsUrl: CALLBACK_A,
      inner: `<Extensions>${padding}</Extensions>`,
    });
    expectRejected(verify(xml), '256 KiB');
  });

  it('rejects mismatched Destination', () => {
    const signed = signRequest(
      requestXml({
        id: '_req-dest',
        acsUrl: CALLBACK_A,
        destination: 'https://other-gateway.example.com/acs',
      }),
      { privateKey: app.privateKey },
    );
    expectRejected(verify(signed), 'Destination');
  });

  it('rejects unknown Issuer', () => {
    const signed = signRequest(
      requestXml({
        id: '_req-issuer',
        acsUrl: CALLBACK_A,
        issuer: 'https://unknown.example.com',
      }),
      { privateKey: app.privateKey },
    );
    expectRejected(verify(signed), 'trusted application');
  });
});

describe('robustness', () => {
  it('rejects deeply nested XML without crashing the process', () => {
    const depth = 200_000;
    const xml =
      '<AuthnRequest xmlns="urn:oasis:names:tc:SAML:2.0:protocol" ID="_deep" Version="2.0">' +
      '<a>'.repeat(depth) +
      '</a>'.repeat(depth) +
      '</AuthnRequest>';
    const result = verify(xml);
    assert.ok(!result.ok);
  });

  it('rejects empty input', () => {
    expectRejected(verify(''), 'root element');
  });
});
