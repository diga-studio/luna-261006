import assert from "node:assert";
import { describe, test } from "node:test";
import { verifyAuthnRequest, type TrustedApplication } from "../src/index";
import {
  APP_ACS_URLS,
  APP_ENTITY_ID,
  GATEWAY_DESTINATION,
  generateRsaKey,
  signAuthnRequest,
  unsignedRequest,
  type TestKey,
} from "./helpers";

const appKey: TestKey = generateRsaKey();
const strangerKey: TestKey = generateRsaKey();

const directory: TrustedApplication[] = [
  {
    entityID: APP_ENTITY_ID,
    publicKey: appKey.publicKeyPem,
    assertionConsumerServiceURLs: [...APP_ACS_URLS],
  },
];

function verify(xml: string, apps: TrustedApplication[] = directory) {
  return verifyAuthnRequest(xml, {
    applications: apps,
    destination: GATEWAY_DESTINATION,
  });
}

describe("valid requests", () => {
  test("default namespaces return exact trusted fields", () => {
    const xml = signAuthnRequest({
      xml: unsignedRequest(),
      privateKey: appKey.privateKey,
    });
    const result = verify(xml);
    assert.deepStrictEqual(result, {
      ok: true,
      id: "_a1b2c3d4e5f6",
      issuer: APP_ENTITY_ID,
      assertionConsumerServiceURL: APP_ACS_URLS[0],
    });
  });

  test("arbitrary prefixes and ancestor-scoped namespaces", () => {
    const xml = signAuthnRequest({
      xml:
        `<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"` +
        ` xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"` +
        ` xmlns:ds="http://www.w3.org/2000/09/xmldsig#"` +
        ` ID="_pfx9" Version="2.0"` +
        ` Destination="${GATEWAY_DESTINATION}"` +
        ` AssertionConsumerServiceURL="${APP_ACS_URLS[1]}">` +
        `<saml:Issuer>${APP_ENTITY_ID}</saml:Issuer>` +
        `<!--SIGNATURE-->` +
        `</samlp:AuthnRequest>`,
      privateKey: appKey.privateKey,
      declareDsOnSignature: false,
    });
    const result = verify(xml);
    assert.deepStrictEqual(result, {
      ok: true,
      id: "_pfx9",
      issuer: APP_ENTITY_ID,
      assertionConsumerServiceURL: APP_ACS_URLS[1],
    });
  });

  test('PrefixList containing "#default" is honored', () => {
    const xml = signAuthnRequest({
      xml: unsignedRequest({ id: "_inclDefault" }),
      privateKey: appKey.privateKey,
      refInclusivePrefixes: ["#default"],
      c14nInclusivePrefixes: ["#default"],
    });
    const result = verify(xml);
    assert.deepStrictEqual(result, {
      ok: true,
      id: "_inclDefault",
      issuer: APP_ENTITY_ID,
      assertionConsumerServiceURL: APP_ACS_URLS[0],
    });
  });

  test("attribute order and character escapes are insignificant", () => {
    const acsWithAmp = "https://app1.example.com/acs?a=1&b=2";
    const apps: TrustedApplication[] = [
      {
        entityID: APP_ENTITY_ID,
        publicKey: appKey.publicKeyPem,
        assertionConsumerServiceURLs: [acsWithAmp],
      },
    ];
    const xml = signAuthnRequest({
      xml:
        `<AuthnRequest AssertionConsumerServiceURL="https://app1.example.com/acs?a=1&amp;b=2"` +
        ` xmlns="urn:oasis:names:tc:SAML:2.0:protocol"` +
        ` Destination="${GATEWAY_DESTINATION}" ID="&#x5F;esc1" Version="2.0">` +
        `<saml:Issuer xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">${APP_ENTITY_ID}</saml:Issuer>` +
        `<!--SIGNATURE-->` +
        `</AuthnRequest>`,
      privateKey: appKey.privateKey,
    });
    const result = verify(xml, apps);
    assert.deepStrictEqual(result, {
      ok: true,
      id: "_esc1",
      issuer: APP_ENTITY_ID,
      assertionConsumerServiceURL: acsWithAmp,
    });
  });

  test("directory with 200 applications resolves the right key", () => {
    const apps: TrustedApplication[] = [];
    for (let i = 0; i < 199; i++) {
      apps.push({
        entityID: `https://other-${i}.example.com/sp`,
        publicKey: strangerKey.publicKeyPem,
        assertionConsumerServiceURLs: ["https://x.example.com/acs"],
      });
    }
    apps.push(directory[0]!);
    const xml = signAuthnRequest({
      xml: unsignedRequest({ id: "_manyApps" }),
      privateKey: appKey.privateKey,
    });
    const result = verify(xml, apps);
    assert.strictEqual(result.ok, true);
    if (result.ok) assert.strictEqual(result.issuer, APP_ENTITY_ID);
  });
});

describe("attacks and invalid requests", () => {
  test("wrapper attack: valid inner signature must not trust the outer request", () => {
    const inner = signAuthnRequest({
      xml: unsignedRequest({ id: "_innerLegit" }),
      privateKey: appKey.privateKey,
    });
    const outer =
      `<AuthnRequest xmlns="urn:oasis:names:tc:SAML:2.0:protocol"` +
      ` Version="2.0" ID="_outerEvil"` +
      ` Destination="${GATEWAY_DESTINATION}"` +
      ` AssertionConsumerServiceURL="https://evil.example.com/acs">` +
      `<saml:Issuer xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">${APP_ENTITY_ID}</saml:Issuer>` +
      `<wrapper>${inner}</wrapper>` +
      `</AuthnRequest>`;
    const result = verify(outer);
    assert.strictEqual(result.ok, false);
    assert.ok(!("id" in result), "no trusted fields may leak");
  });

  test("tampered AssertionConsumerServiceURL after signing is rejected", () => {
    const xml = signAuthnRequest({
      xml: unsignedRequest(),
      privateKey: appKey.privateKey,
    }).replace(APP_ACS_URLS[0], "https://evil.example.com/acs");
    const result = verify(xml);
    assert.strictEqual(result.ok, false);
  });

  test("duplicate ID attribute values are rejected", () => {
    const xml = signAuthnRequest({
      xml: unsignedRequest({
        id: "_dup",
        issuerElement:
          `<saml:Issuer xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_dup">${APP_ENTITY_ID}</saml:Issuer>`,
      }),
      privateKey: appKey.privateKey,
    });
    const result = verify(xml);
    assert.strictEqual(result.ok, false);
    if (!result.ok) assert.match(result.reason, /duplicate ID/);
  });

  test("duplicate namespaced id attribute values are rejected", () => {
    const xml = signAuthnRequest({
      xml: unsignedRequest({
        id: "_dupNs",
        issuerElement:
          `<saml:Issuer xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"` +
          ` xmlns:x="urn:example:x" x:id="_dupNs">${APP_ENTITY_ID}</saml:Issuer>`,
      }),
      privateKey: appKey.privateKey,
    });
    const result = verify(xml);
    assert.strictEqual(result.ok, false);
    if (!result.ok) assert.match(result.reason, /duplicate ID/);
  });

  test("signature made only by a stranger key carried in KeyInfo is rejected", () => {
    const jwk = strangerKey.publicKeyPem; // directory only trusts appKey
    void jwk;
    const xml = signAuthnRequest({
      xml: unsignedRequest({ id: "_stranger" }),
      privateKey: strangerKey.privateKey,
      keyInfoXml:
        `<ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#">` +
        `<ds:KeyName>stranger</ds:KeyName>` +
        `</ds:KeyInfo>`,
    });
    const result = verify(xml);
    assert.strictEqual(result.ok, false);
  });

  test("unknown Issuer is rejected", () => {
    const xml = signAuthnRequest({
      xml: unsignedRequest({ issuer: "https://unknown.example.com/sp" }),
      privateKey: appKey.privateKey,
    });
    const result = verify(xml);
    assert.strictEqual(result.ok, false);
    if (!result.ok) assert.match(result.reason, /unknown Issuer/);
  });

  test("foreign Destination is rejected", () => {
    const xml = signAuthnRequest({
      xml: unsignedRequest({ destination: "https://other-idp.example.com/sso" }),
      privateKey: appKey.privateKey,
    });
    const result = verify(xml);
    assert.strictEqual(result.ok, false);
    if (!result.ok) assert.match(result.reason, /Destination/);
  });

  test("unregistered callback URL is rejected", () => {
    const xml = signAuthnRequest({
      xml: unsignedRequest({ acsUrl: "https://app1.example.com/saml/evil" }),
      privateKey: appKey.privateKey,
    });
    const result = verify(xml);
    assert.strictEqual(result.ok, false);
    if (!result.ok) assert.match(result.reason, /AssertionConsumerServiceURL/);
  });

  test("DOCTYPE is rejected", () => {
    const xml = signAuthnRequest({
      xml: unsignedRequest(),
      privateKey: appKey.privateKey,
    });
    const withDoctype = xml.replace(
      "<AuthnRequest",
      `<!DOCTYPE AuthnRequest [<!ENTITY x "y">]><AuthnRequest`
    );
    const result = verify(withDoctype);
    assert.strictEqual(result.ok, false);
  });

  test("entity references are rejected", () => {
    const result = verify(
      `<AuthnRequest xmlns="urn:oasis:names:tc:SAML:2.0:protocol" Version="2.0" ID="_e">` +
        `<saml:Issuer xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">&xxe;</saml:Issuer>` +
        `</AuthnRequest>`
    );
    assert.strictEqual(result.ok, false);
  });

  test("Reference URI not matching the root ID is rejected", () => {
    const xml = signAuthnRequest({
      xml: unsignedRequest(),
      privateKey: appKey.privateKey,
    }).replace('URI="#_a1b2c3d4e5f6"', 'URI="#_somethingElse"');
    const result = verify(xml);
    assert.strictEqual(result.ok, false);
    if (!result.ok) assert.match(result.reason, /Reference URI/);
  });

  test("more than one Signature element is rejected", () => {
    const inner = signAuthnRequest({
      xml: unsignedRequest({ id: "_a1b2c3d4e5f6" }),
      privateKey: appKey.privateKey,
    });
    const sigMatch = inner.match(/<ds:Signature[\s\S]*<\/ds:Signature>/);
    assert.ok(sigMatch !== null);
    const doubled = inner.replace(
      "</AuthnRequest>",
      `${sigMatch[0]}</AuthnRequest>`
    );
    const result = verify(doubled);
    assert.strictEqual(result.ok, false);
  });

  test("unsupported signature algorithm is rejected", () => {
    const xml = signAuthnRequest({
      xml: unsignedRequest(),
      privateKey: appKey.privateKey,
    }).replace(
      "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
      "http://www.w3.org/2000/09/xmldsig#rsa-sha1"
    );
    const result = verify(xml);
    assert.strictEqual(result.ok, false);
    if (!result.ok) assert.match(result.reason, /signature algorithm/);
  });

  test("malformed XML is rejected without throwing", () => {
    for (const bad of [
      "",
      "not xml at all",
      "<AuthnRequest>",
      "<a></b>",
      "\u0000\u0001",
    ]) {
      const result = verify(bad);
      assert.strictEqual(result.ok, false, JSON.stringify(bad));
    }
  });

  test("oversized requests are rejected", () => {
    const xml = signAuthnRequest({
      xml: unsignedRequest(),
      privateKey: appKey.privateKey,
    });
    const padded = xml.replace(
      "</AuthnRequest>",
      `${"<!--".padEnd(0)}<pad>${"x".repeat(300 * 1024)}</pad></AuthnRequest>`
    );
    const result = verify(padded);
    assert.strictEqual(result.ok, false);
    if (!result.ok) assert.match(result.reason, /size/);
  });
});
