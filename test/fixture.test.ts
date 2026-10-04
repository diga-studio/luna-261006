import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { verifyAuthnRequest } from '../src/index.js';

// 冻结的真实 RSA-SHA256 签名样例（私钥已丢弃，不可再生成）。
// 特点：ds 前缀继承自根元素声明；SignedInfo 与 Reference 变换均使用
// InclusiveNamespaces PrefixList="#default"。
const FIXTURE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAzXCN5C84sTdG4HJFKdoW
nqbHvk38zThOY3mw8yq7Gk1oDz5RWdUZiya3OOVduNWDwfQODIOJkxXqxvIN+VO0
g9ah05LtrdgIxHr46IbnkaZ7ulwy+EudFNBdjItZx2bEp2ECCErGbaiIhclC/MMM
Tp9KUg92SAFXWNPkGoFhQbysdVVNy+frrbfbOwJDcsbXHAY8sdb71jnsvC3LLr2V
YLqVQE5S0PdGW5JY9K8Z5jNSR3F9yWXAeYJBd5EqnbF380rQ/vjYtIfHcsb4xo/s
cLn6VDYbMfNRUaB0PyjwwsxZTHhuOuMARWpapoAlYzWpR4ATd3HdiofUzDlaR+5s
NwIDAQAB
-----END PUBLIC KEY-----
`;

const FIXTURE_XML = `<AuthnRequest xmlns="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" ID="_fixture-9f8e7d6c" Version="2.0" IssueInstant="2026-10-04T08:00:00Z" Destination="https://gateway.example.com/saml/acs" AssertionConsumerServiceURL="https://fixture-app.example.com/saml/callback"><Issuer xmlns="urn:oasis:names:tc:SAML:2.0:assertion">https://fixture-app.example.com/saml</Issuer><ds:Signature><ds:SignedInfo><ds:CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"><ec:InclusiveNamespaces xmlns:ec="http://www.w3.org/2001/10/xml-exc-c14n#" PrefixList="#default"></ec:InclusiveNamespaces></ds:CanonicalizationMethod><ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"></ds:SignatureMethod><ds:Reference URI="#_fixture-9f8e7d6c"><ds:Transforms><ds:Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"></ds:Transform><ds:Transform Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"><ec:InclusiveNamespaces xmlns:ec="http://www.w3.org/2001/10/xml-exc-c14n#" PrefixList="#default"></ec:InclusiveNamespaces></ds:Transform></ds:Transforms><ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"></ds:DigestMethod><ds:DigestValue>CrYbcqOfZfub75RzU5VeacGn1EUEfzes8cm1sjAyc7k=</ds:DigestValue></ds:Reference></ds:SignedInfo><ds:SignatureValue>eSYsPNfv+GSuezeQwXonqQdfT71wJr5b4WLzf8XM6E6QPGuTUfb4tONWtxP/0NarR9qzHQuGR96htOiNwJ+2uwLnnKC5D3DtGJ9DxsnohhSEFXDumVSC4zoHzRRQzq6ICbkFA1vkdyfHVinV+s79U9mPm2qvuS5+iYC6lClVX3nf3mNax/vP7GdF9peyTcb/oQFtnj5MwCW12dppMypzIwADWTb+MWR9Oh2WcqG6YevYMQ77mhIhvY58wsk5vOYK8g8yZcO7/ZpFrzmPPCg/4v2KQPL/Tmc/W07V1SpIGRwPd5M+Na7GEkkOlFaR5HyrOFprcP2tmmmSW4vro57fkA==</ds:SignatureValue></ds:Signature></AuthnRequest>`;

const GATEWAY = 'https://gateway.example.com/saml/acs';

const trustedApps = [
  {
    entityId: 'https://fixture-app.example.com/saml',
    publicKeyPem: FIXTURE_PUBLIC_KEY_PEM,
    callbackUrls: ['https://fixture-app.example.com/saml/callback'],
  },
];

describe('frozen known-answer fixture', () => {
  it('verifies the frozen signed request and returns exact fields', () => {
    const result = verifyAuthnRequest({
      xml: FIXTURE_XML,
      trustedApps,
      destination: GATEWAY,
    });
    assert.ok(result.ok, `fixture must verify: ${result.ok ? '' : result.reason}`);
    assert.equal(result.id, '_fixture-9f8e7d6c');
    assert.equal(result.entityId, 'https://fixture-app.example.com/saml');
    assert.equal(
      result.assertionConsumerServiceUrl,
      'https://fixture-app.example.com/saml/callback',
    );
  });

  it('rejects the fixture after a single-character callback change', () => {
    const tampered = FIXTURE_XML.replace(
      'https://fixture-app.example.com/saml/callback',
      'https://fixture-app.example.com/saml/callbacj',
    );
    const result = verifyAuthnRequest({
      xml: tampered,
      trustedApps: [
        { ...trustedApps[0]!, callbackUrls: ['https://fixture-app.example.com/saml/callbacj'] },
      ],
      destination: GATEWAY,
    });
    assert.ok(!result.ok);
    assert.match(result.reason, /digest mismatch/);
  });
});
