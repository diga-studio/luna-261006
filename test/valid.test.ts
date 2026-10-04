import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { verifyAuthnRequest } from '../src/index.js';
import {
  GATEWAY_DESTINATION,
  makeApp,
  signRequest,
  trustedDir,
} from './helpers.js';

const APP_ENTITY = 'https://app.example.com/saml';
const APP_ACS = 'https://app.example.com/login/callback';
const APP_ACS_SECONDARY = 'https://app.example.com/login/callback2';
const REQUEST_ID = '_a1b2c3d4-request';

function expectOk(result: ReturnType<typeof verifyAuthnRequest>) {
  assert.ok(result.ok, `expected ok, got rejection: ${result.ok ? '' : result.reason}`);
  assert.equal(result.id, REQUEST_ID);
  assert.equal(result.entityId, APP_ENTITY);
  assert.equal(result.assertionConsumerServiceUrl, APP_ACS);
}

describe('valid AuthnRequest', () => {
  it('accepts default-namespace request and returns exact fields', () => {
    const app = makeApp(APP_ENTITY, [APP_ACS]);
    const xml =
      `<AuthnRequest xmlns="urn:oasis:names:tc:SAML:2.0:protocol"` +
      ` ID="${REQUEST_ID}" Version="2.0" IssueInstant="2026-10-04T00:00:00Z"` +
      ` Destination="${GATEWAY_DESTINATION}"` +
      ` AssertionConsumerServiceURL="${APP_ACS}">` +
      `<Issuer xmlns="urn:oasis:names:tc:SAML:2.0:assertion">${APP_ENTITY}</Issuer>` +
      `</AuthnRequest>`;
    const signed = signRequest(xml, { privateKey: app.privateKey });
    const result = verifyAuthnRequest({
      xml: signed,
      trustedApps: trustedDir([app]),
      destination: GATEWAY_DESTINATION,
    });
    expectOk(result);
  });

  it('accepts prefixed request with arbitrary prefix names', () => {
    const app = makeApp(APP_ENTITY, [APP_ACS]);
    const xml =
      `<p:AuthnRequest xmlns:p="urn:oasis:names:tc:SAML:2.0:protocol"` +
      ` xmlns:a="urn:oasis:names:tc:SAML:2.0:assertion"` +
      ` ID="${REQUEST_ID}" Version="2.0"` +
      ` Destination="${GATEWAY_DESTINATION}"` +
      ` AssertionConsumerServiceURL="${APP_ACS}">` +
      `<a:Issuer>${APP_ENTITY}</a:Issuer>` +
      `</p:AuthnRequest>`;
    const signed = signRequest(xml, { privateKey: app.privateKey });
    const result = verifyAuthnRequest({
      xml: signed,
      trustedApps: trustedDir([app]),
      destination: GATEWAY_DESTINATION,
    });
    expectOk(result);
  });

  it('accepts ds prefix inherited from an ancestor declaration', () => {
    const app = makeApp(APP_ENTITY, [APP_ACS]);
    const xml =
      `<AuthnRequest xmlns="urn:oasis:names:tc:SAML:2.0:protocol"` +
      ` xmlns:ds="http://www.w3.org/2000/09/xmldsig#"` +
      ` xmlns:unused="urn:never-used"` +
      ` ID="${REQUEST_ID}" Version="2.0"` +
      ` Destination="${GATEWAY_DESTINATION}"` +
      ` AssertionConsumerServiceURL="${APP_ACS}">` +
      `<Issuer xmlns="urn:oasis:names:tc:SAML:2.0:assertion">${APP_ENTITY}</Issuer>` +
      `<!-- a comment that c14n must drop -->` +
      `</AuthnRequest>`;
    const signed = signRequest(xml, {
      privateKey: app.privateKey,
      inheritDsNamespace: true,
    });
    const result = verifyAuthnRequest({
      xml: signed,
      trustedApps: trustedDir([app]),
      destination: GATEWAY_DESTINATION,
    });
    expectOk(result);
  });

  it('accepts InclusiveNamespaces PrefixList containing #default', () => {
    const app = makeApp(APP_ENTITY, [APP_ACS]);
    const xml =
      `<AuthnRequest xmlns="urn:oasis:names:tc:SAML:2.0:protocol"` +
      ` ID="${REQUEST_ID}" Version="2.0"` +
      ` Destination="${GATEWAY_DESTINATION}"` +
      ` AssertionConsumerServiceURL="${APP_ACS}">` +
      `<Issuer xmlns="urn:oasis:names:tc:SAML:2.0:assertion">${APP_ENTITY}</Issuer>` +
      `</AuthnRequest>`;
    const signed = signRequest(xml, {
      privateKey: app.privateKey,
      c14nPrefixList: '#default',
      refPrefixList: '#default',
    });
    const result = verifyAuthnRequest({
      xml: signed,
      trustedApps: trustedDir([app]),
      destination: GATEWAY_DESTINATION,
    });
    expectOk(result);
  });

  it('accepts attribute reordering and character escaping', () => {
    const entity = 'app-&-one';
    const app = makeApp(entity, [APP_ACS]);
    const xml =
      `<AuthnRequest xmlns="urn:oasis:names:tc:SAML:2.0:protocol"` +
      ` AssertionConsumerServiceURL="${APP_ACS}"` +
      ` Destination="${GATEWAY_DESTINATION}"` +
      ` Version="2.0" ID="${REQUEST_ID}">` +
      `<Issuer xmlns="urn:oasis:names:tc:SAML:2.0:assertion">app-&amp;-one</Issuer>` +
      `</AuthnRequest>`;
    const signed = signRequest(xml, { privateKey: app.privateKey });
    const result = verifyAuthnRequest({
      xml: signed,
      trustedApps: trustedDir([app]),
      destination: GATEWAY_DESTINATION,
    });
    assert.ok(result.ok);
    assert.equal(result.entityId, entity);
    assert.equal(result.id, REQUEST_ID);
  });

  it('selects the correct key among 200 trusted applications', () => {
    const target = makeApp(APP_ENTITY, [APP_ACS, APP_ACS_SECONDARY]);
    const decoyKey = makeApp('decoy', []);
    const decoys = Array.from({ length: 199 }, (_, i) => ({
      entityId: `https://decoy-${i}.example.com`,
      publicKeyPem: decoyKey.publicKeyPem,
      callbackUrls: [`https://decoy-${i}.example.com/cb`],
    }));
    const apps = [...decoys.slice(0, 100), target, ...decoys.slice(100)];
    const xml =
      `<AuthnRequest xmlns="urn:oasis:names:tc:SAML:2.0:protocol"` +
      ` ID="${REQUEST_ID}" Version="2.0"` +
      ` Destination="${GATEWAY_DESTINATION}"` +
      ` AssertionConsumerServiceURL="${APP_ACS_SECONDARY}">` +
      `<Issuer xmlns="urn:oasis:names:tc:SAML:2.0:assertion">${APP_ENTITY}</Issuer>` +
      `</AuthnRequest>`;
    const signed = signRequest(xml, { privateKey: target.privateKey });
    const result = verifyAuthnRequest({
      xml: signed,
      trustedApps: trustedDir(apps),
      destination: GATEWAY_DESTINATION,
    });
    assert.ok(result.ok, `expected ok: ${result.ok ? '' : result.reason}`);
    assert.equal(result.entityId, APP_ENTITY);
    assert.equal(result.assertionConsumerServiceUrl, APP_ACS_SECONDARY);
  });
});
