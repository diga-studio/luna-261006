/**
 * SAML 2.0 AuthnRequest (HTTP-POST binding) signature verification.
 *
 * The verifier only accepts a request when the single XML signature on the
 * root AuthnRequest provably protects exactly the content the gateway will
 * act on (ID, Issuer, Destination, AssertionConsumerServiceURL). Trust
 * comes solely from the caller-supplied application directory; KeyInfo is
 * never a trust source.
 */

import { createHash, createPublicKey, createVerify, timingSafeEqual } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { canonicalizeDocument, canonicalizeElement } from "./c14n";
import {
  allElements,
  directChildren,
  getAttribute,
  parseXml,
  textContent,
  XmlParseError,
} from "./xml";
import type { XmlElement } from "./xml";

export interface TrustedApplication {
  /** Unique entityID of the relying application. */
  entityID: string;
  /** RSA public key (PEM string, DER Buffer or KeyObject). */
  publicKey: string | Buffer | KeyObject;
  /** Exact allowed AssertionConsumerServiceURL values. */
  assertionConsumerServiceURLs: readonly string[];
}

export interface VerifyOptions {
  /** In-memory trusted application directory (up to ~200 entries). */
  applications: readonly TrustedApplication[];
  /** This gateway's own Destination value. */
  destination: string;
  /** Maximum accepted XML size in bytes. Defaults to 256 KiB. */
  maxXmlBytes?: number;
}

export interface VerifySuccess {
  ok: true;
  /** Trusted AuthnRequest ID. */
  id: string;
  /** Trusted application entityID. */
  issuer: string;
  /** Trusted callback URL taken from the signed request. */
  assertionConsumerServiceURL: string;
}

export interface VerifyFailure {
  ok: false;
  /** Human-readable rejection reason; never carries trusted fields. */
  reason: string;
}

export type VerifyResult = VerifySuccess | VerifyFailure;

const SAML2P_NS = "urn:oasis:names:tc:SAML:2.0:protocol";
const SAML2_NS = "urn:oasis:names:tc:SAML:2.0:assertion";
const DS_NS = "http://www.w3.org/2000/09/xmldsig#";
const EXC_C14N_NS = "http://www.w3.org/2001/10/xml-exc-c14n#";
const ALG_EXC_C14N = "http://www.w3.org/2001/10/xml-exc-c14n#";
const ALG_ENVELOPED = "http://www.w3.org/2000/09/xmldsig#enveloped-signature";
const ALG_RSA_SHA256 = "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256";
const ALG_SHA256 = "http://www.w3.org/2001/04/xmlenc#sha256";

const DEFAULT_MAX_XML_BYTES = 256 * 1024;

function fail(reason: string): VerifyFailure {
  return { ok: false, reason };
}

function textOnly(element: XmlElement): string | null {
  let out = "";
  for (const child of element.children) {
    if (child.kind !== "text") return null;
    out += child.text;
  }
  return out;
}

function decodeBase64(text: string): Buffer | null {
  const compact = text.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 !== 0) {
    return null;
  }
  return Buffer.from(compact, "base64");
}

/** Parse an InclusiveNamespaces child element into a prefix list. */
function parseInclusiveNamespaces(
  parent: XmlElement
): { prefixes: string[] } | { error: string } {
  const matches = directChildren(parent, EXC_C14N_NS, "InclusiveNamespaces");
  if (matches.length > 1) {
    return { error: "multiple InclusiveNamespaces elements" };
  }
  const other = parent.children.filter(
    (c) => c.kind === "element" && c !== matches[0]
  );
  if (other.length > 0) {
    return { error: `unsupported child of ${parent.localName}` };
  }
  if (matches.length === 0) return { prefixes: [] };
  const list = getAttribute(matches[0]!, "PrefixList");
  if (list === undefined) return { prefixes: [] };
  return { prefixes: list.split(/\s+/).filter((p) => p.length > 0) };
}

export function verifyAuthnRequest(
  xml: string | Buffer,
  options: VerifyOptions
): VerifyResult {
  const maxBytes = options.maxXmlBytes ?? DEFAULT_MAX_XML_BYTES;
  const text = typeof xml === "string" ? xml : xml.toString("utf8");
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    return fail("request exceeds the maximum allowed size");
  }

  let doc;
  try {
    doc = parseXml(text);
  } catch (err) {
    if (err instanceof XmlParseError) {
      return fail(`malformed XML: ${err.message}`);
    }
    throw err;
  }

  // --- Root element and basic AuthnRequest shape -------------------------
  const root = doc.root;
  if (root.namespaceURI !== SAML2P_NS || root.localName !== "AuthnRequest") {
    return fail("root element is not a SAML 2.0 AuthnRequest");
  }
  if (getAttribute(root, "Version") !== "2.0") {
    return fail('AuthnRequest Version must be "2.0"');
  }
  const requestId = getAttribute(root, "ID");
  if (requestId === undefined || requestId.length === 0) {
    return fail("AuthnRequest must carry a non-empty ID attribute");
  }

  // --- Global ID uniqueness (any namespace, local name ID/Id/id) ---------
  const seenIds = new Set<string>();
  for (const el of allElements(doc)) {
    for (const attr of el.attributes) {
      if (attr.localName === "ID" || attr.localName === "Id" || attr.localName === "id") {
        if (seenIds.has(attr.value)) {
          return fail("duplicate ID attribute value in document");
        }
        seenIds.add(attr.value);
      }
    }
  }

  // --- Issuer and trusted application lookup ------------------------------
  const issuers = directChildren(root, SAML2_NS, "Issuer");
  if (issuers.length !== 1) {
    return fail("AuthnRequest must contain exactly one Issuer");
  }
  const issuerText = textOnly(issuers[0]!);
  if (issuerText === null || issuerText.length === 0) {
    return fail("Issuer must contain plain text");
  }
  const app = options.applications.find((a) => a.entityID === issuerText);
  if (app === undefined) {
    return fail("unknown Issuer");
  }

  // --- Destination and callback URL ---------------------------------------
  const destination = getAttribute(root, "Destination");
  if (destination === undefined || destination !== options.destination) {
    return fail("Destination does not match this gateway");
  }
  const acsUrl = getAttribute(root, "AssertionConsumerServiceURL");
  if (acsUrl === undefined || !app.assertionConsumerServiceURLs.includes(acsUrl)) {
    return fail("AssertionConsumerServiceURL is not registered for this application");
  }

  // --- Signature element: exactly one, direct child of root ---------------
  const signatures: XmlElement[] = [];
  for (const el of allElements(doc)) {
    if (el.namespaceURI === DS_NS && el.localName === "Signature") {
      signatures.push(el);
    }
  }
  if (signatures.length !== 1) {
    return fail("document must contain exactly one XML signature");
  }
  const signature = signatures[0]!;
  if (signature.parent !== root) {
    return fail("Signature must be a direct child of the AuthnRequest root");
  }
  for (const child of signature.children) {
    if (child.kind !== "element") continue;
    const ok =
      (child.namespaceURI === DS_NS &&
        (child.localName === "SignedInfo" ||
          child.localName === "SignatureValue" ||
          child.localName === "KeyInfo"));
    if (!ok) return fail("unsupported element inside Signature");
  }

  // --- SignedInfo structure ------------------------------------------------
  const signedInfos = directChildren(signature, DS_NS, "SignedInfo");
  if (signedInfos.length !== 1) {
    return fail("Signature must contain exactly one SignedInfo");
  }
  const signedInfo = signedInfos[0]!;

  const c14nMethods = directChildren(signedInfo, DS_NS, "CanonicalizationMethod");
  if (c14nMethods.length !== 1) {
    return fail("SignedInfo must contain exactly one CanonicalizationMethod");
  }
  if (getAttribute(c14nMethods[0]!, "Algorithm") !== ALG_EXC_C14N) {
    return fail("unsupported canonicalization algorithm");
  }
  const c14nInclusive = parseInclusiveNamespaces(c14nMethods[0]!);
  if ("error" in c14nInclusive) {
    return fail(`CanonicalizationMethod: ${c14nInclusive.error}`);
  }

  const sigMethods = directChildren(signedInfo, DS_NS, "SignatureMethod");
  if (sigMethods.length !== 1) {
    return fail("SignedInfo must contain exactly one SignatureMethod");
  }
  if (getAttribute(sigMethods[0]!, "Algorithm") !== ALG_RSA_SHA256) {
    return fail("unsupported signature algorithm (only RSA-SHA256)");
  }

  const references = directChildren(signedInfo, DS_NS, "Reference");
  if (references.length !== 1) {
    return fail("SignedInfo must contain exactly one Reference");
  }
  const reference = references[0]!;
  if (getAttribute(reference, "URI") !== `#${requestId}`) {
    return fail("Reference URI must literally match the AuthnRequest ID");
  }
  for (const child of signedInfo.children) {
    if (child.kind !== "element") continue;
    const ok =
      child.namespaceURI === DS_NS &&
      (child.localName === "CanonicalizationMethod" ||
        child.localName === "SignatureMethod" ||
        child.localName === "Reference");
    if (!ok) return fail("unsupported element inside SignedInfo");
  }

  // --- Reference transforms -------------------------------------------------
  const transformsEls = directChildren(reference, DS_NS, "Transforms");
  if (transformsEls.length !== 1) {
    return fail("Reference must contain exactly one Transforms element");
  }
  const transforms = directChildren(transformsEls[0]!, DS_NS, "Transform");
  if (transforms.length !== 2) {
    return fail("Reference must apply exactly two transforms");
  }
  if (getAttribute(transforms[0]!, "Algorithm") !== ALG_ENVELOPED) {
    return fail("first transform must be enveloped-signature");
  }
  if (transforms[0]!.children.some((c) => c.kind === "element")) {
    return fail("enveloped-signature transform takes no parameters");
  }
  if (getAttribute(transforms[1]!, "Algorithm") !== ALG_EXC_C14N) {
    return fail("second transform must be exclusive C14N without comments");
  }
  const refInclusive = parseInclusiveNamespaces(transforms[1]!);
  if ("error" in refInclusive) {
    return fail(`Transform: ${refInclusive.error}`);
  }
  for (const child of reference.children) {
    if (child.kind !== "element") continue;
    const ok =
      child.namespaceURI === DS_NS &&
      (child.localName === "Transforms" ||
        child.localName === "DigestMethod" ||
        child.localName === "DigestValue");
    if (!ok) return fail("unsupported element inside Reference");
  }

  const digestMethods = directChildren(reference, DS_NS, "DigestMethod");
  if (digestMethods.length !== 1) {
    return fail("Reference must contain exactly one DigestMethod");
  }
  if (getAttribute(digestMethods[0]!, "Algorithm") !== ALG_SHA256) {
    return fail("unsupported digest algorithm (only SHA-256)");
  }

  const digestValues = directChildren(reference, DS_NS, "DigestValue");
  if (digestValues.length !== 1) {
    return fail("Reference must contain exactly one DigestValue");
  }
  const digestText = textOnly(digestValues[0]!);
  const expectedDigest = digestText === null ? null : decodeBase64(digestText);
  if (expectedDigest === null) {
    return fail("DigestValue is not valid base64 text");
  }

  const sigValues = directChildren(signature, DS_NS, "SignatureValue");
  if (sigValues.length !== 1) {
    return fail("Signature must contain exactly one SignatureValue");
  }
  const sigText = textOnly(sigValues[0]!);
  const signatureBytes = sigText === null ? null : decodeBase64(sigText);
  if (signatureBytes === null) {
    return fail("SignatureValue is not valid base64 text");
  }

  // --- Digest over the enveloped, canonicalized document -------------------
  const canonicalDoc = canonicalizeDocument(
    doc,
    { inclusivePrefixes: refInclusive.prefixes },
    signature
  );
  const actualDigest = createHash("sha256").update(canonicalDoc, "utf8").digest();
  if (
    expectedDigest.length !== actualDigest.length ||
    !timingSafeEqual(expectedDigest, actualDigest)
  ) {
    return fail("document digest does not match DigestValue");
  }

  // --- RSA-SHA256 signature over canonicalized SignedInfo ------------------
  const canonicalSignedInfo = canonicalizeElement(signedInfo, {
    inclusivePrefixes: c14nInclusive.prefixes,
  });
  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey(app.publicKey as string | Buffer | KeyObject);
  } catch {
    return fail("trusted public key for this application is unusable");
  }
  let signatureOk = false;
  try {
    signatureOk = createVerify("RSA-SHA256")
      .update(canonicalSignedInfo, "utf8")
      .verify(publicKey, signatureBytes);
  } catch {
    return fail("signature verification failed");
  }
  if (!signatureOk) {
    return fail("signature does not verify against the trusted key");
  }

  return {
    ok: true,
    id: requestId,
    issuer: issuerText,
    assertionConsumerServiceURL: acsUrl,
  };
}
