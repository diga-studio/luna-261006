/**
 * Test helpers: real RSA keys and a real XML-DSig signer that produces
 * standards-compliant signatures (enveloped-signature + exclusive C14N,
 * RSA-SHA256) using the library under test for canonicalization.
 */

import { createHash, createSign, generateKeyPairSync } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { canonicalizeDocument, canonicalizeElement } from "../src/c14n";
import { allElements, getAttribute, parseXml } from "../src/xml";

export const GATEWAY_DESTINATION = "https://idp.example.com/saml/sso";

export const APP_ENTITY_ID = "https://app1.example.com/sp";
export const APP_ACS_URLS = [
  "https://app1.example.com/saml/acs",
  "https://app1.example.com/saml/acs2",
] as const;

export interface TestKey {
  publicKeyPem: string;
  privateKey: KeyObject;
}

export function generateRsaKey(): TestKey {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  return {
    publicKeyPem: publicKey.export({ format: "pem", type: "spki" }) as string,
    privateKey,
  };
}

const DS_NS = "http://www.w3.org/2000/09/xmldsig#";
const EXC_C14N = "http://www.w3.org/2001/10/xml-exc-c14n#";
const ENVELOPED = "http://www.w3.org/2000/09/xmldsig#enveloped-signature";
const RSA_SHA256 = "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256";
const SHA256 = "http://www.w3.org/2001/04/xmlenc#sha256";

export interface SignOptions {
  /**
   * Unsigned AuthnRequest XML. Must contain the literal comment
   * "<!--SIGNATURE-->" where the Signature element should be inserted.
   */
  xml: string;
  privateKey: KeyObject;
  /** PrefixList for the exclusive-C14N Reference transform. */
  refInclusivePrefixes?: string[];
  /** PrefixList for the SignedInfo CanonicalizationMethod. */
  c14nInclusivePrefixes?: string[];
  /** Optional KeyInfo XML inserted after SignatureValue. */
  keyInfoXml?: string;
  /** Declare xmlns:ds on the Signature element (default true). */
  declareDsOnSignature?: boolean;
}

function inclusiveNamespacesXml(prefixes: string[] | undefined): string {
  if (prefixes === undefined || prefixes.length === 0) return "";
  return `<ec:InclusiveNamespaces xmlns:ec="${EXC_C14N}" PrefixList="${prefixes.join(" ")}"/>`;
}

/** Sign an AuthnRequest, returning the complete signed XML document. */
export function signAuthnRequest(options: SignOptions): string {
  const doc = parseXml(options.xml.replace("<!--SIGNATURE-->", ""));
  const requestId = getAttribute(doc.root, "ID");
  if (requestId === undefined) throw new Error("test XML needs an ID");

  const canonicalForDigest = canonicalizeDocument(doc, {
    inclusivePrefixes: options.refInclusivePrefixes ?? [],
  });
  const digest = createHash("sha256")
    .update(canonicalForDigest, "utf8")
    .digest()
    .toString("base64");

  const dsDecl =
    options.declareDsOnSignature === false ? "" : ` xmlns:ds="${DS_NS}"`;
  const signatureXml =
    `<ds:Signature${dsDecl}>` +
    `<ds:SignedInfo>` +
    `<ds:CanonicalizationMethod Algorithm="${EXC_C14N}">` +
    inclusiveNamespacesXml(options.c14nInclusivePrefixes) +
    `</ds:CanonicalizationMethod>` +
    `<ds:SignatureMethod Algorithm="${RSA_SHA256}"/>` +
    `<ds:Reference URI="#${requestId}">` +
    `<ds:Transforms>` +
    `<ds:Transform Algorithm="${ENVELOPED}"/>` +
    `<ds:Transform Algorithm="${EXC_C14N}">` +
    inclusiveNamespacesXml(options.refInclusivePrefixes) +
    `</ds:Transform>` +
    `</ds:Transforms>` +
    `<ds:DigestMethod Algorithm="${SHA256}"/>` +
    `<ds:DigestValue>${digest}</ds:DigestValue>` +
    `</ds:Reference>` +
    `</ds:SignedInfo>` +
    `<ds:SignatureValue>__SIGNATURE_VALUE__</ds:SignatureValue>` +
    (options.keyInfoXml ?? "") +
    `</ds:Signature>`;

  const withSignature = options.xml.replace("<!--SIGNATURE-->", signatureXml);

  const signedDoc = parseXml(withSignature);
  let signedInfo;
  for (const el of allElements(signedDoc)) {
    if (el.namespaceURI === DS_NS && el.localName === "SignedInfo") {
      signedInfo = el;
    }
  }
  if (signedInfo === undefined) throw new Error("SignedInfo not found");
  const canonicalSignedInfo = canonicalizeElement(signedInfo, {
    inclusivePrefixes: options.c14nInclusivePrefixes ?? [],
  });
  const signatureValue = createSign("RSA-SHA256")
    .update(canonicalSignedInfo, "utf8")
    .sign(options.privateKey)
    .toString("base64");

  return withSignature.replace("__SIGNATURE_VALUE__", signatureValue);
}

/** A minimal unsigned AuthnRequest template using default namespaces. */
export function unsignedRequest(overrides?: {
  id?: string;
  issuer?: string;
  destination?: string;
  acsUrl?: string;
  issuerElement?: string;
}): string {
  const id = overrides?.id ?? "_a1b2c3d4e5f6";
  const issuer = overrides?.issuer ?? APP_ENTITY_ID;
  const destination = overrides?.destination ?? GATEWAY_DESTINATION;
  const acsUrl = overrides?.acsUrl ?? APP_ACS_URLS[0];
  const issuerElement =
    overrides?.issuerElement ??
    `<saml:Issuer xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">${issuer}</saml:Issuer>`;
  return (
    `<AuthnRequest xmlns="urn:oasis:names:tc:SAML:2.0:protocol"` +
    ` Version="2.0" ID="${id}"` +
    ` Destination="${destination}"` +
    ` AssertionConsumerServiceURL="${acsUrl}">` +
    issuerElement +
    `<!--SIGNATURE-->` +
    `</AuthnRequest>`
  );
}
