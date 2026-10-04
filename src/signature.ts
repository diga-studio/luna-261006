import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { canonicalize } from './c14n.js';
import type { XmlDocument, XmlElement } from './model.js';
import {
  childElements,
  findChildren,
  getAttribute,
  iterateElements,
  textContent,
} from './model.js';
import {
  ALG_DIGEST_SHA256,
  ALG_EXC_C14N,
  ALG_RSA_SHA256,
  ALG_TRANSFORM_ENVELOPED,
  NS_XMLDSIG,
} from './namespaces.js';

function fail(message: string): never {
  throw new Error(message);
}

/** 读取 InclusiveNamespaces 子元素的 PrefixList；没有则返回空列表。 */
function readPrefixList(holder: XmlElement, what: string): string[] {
  const others = childElements(holder);
  if (others.length === 0) {
    return [];
  }
  if (
    others.length === 1 &&
    others[0]!.namespaceURI === ALG_EXC_C14N &&
    others[0]!.localName === 'InclusiveNamespaces'
  ) {
    const list = getAttribute(others[0]!, 'PrefixList');
    return list === undefined ? [] : list.split(/\s+/).filter((p) => p !== '');
  }
  return fail(`${what} has unsupported children`);
}

function requireSingleChild(
  parent: XmlElement,
  localName: string,
  what: string,
): XmlElement {
  const found = findChildren(parent, NS_XMLDSIG, localName);
  if (found.length !== 1) {
    fail(`${what} must contain exactly one ${localName}`);
  }
  return found[0]!;
}

function requireAlgorithm(el: XmlElement, expected: string, what: string): void {
  if (getAttribute(el, 'Algorithm') !== expected) {
    fail(`${what} uses an unsupported algorithm`);
  }
}

function decodeBase64Text(el: XmlElement, what: string): string {
  const compact = textContent(el).replace(/\s+/g, '');
  if (compact === '' || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    fail(`${what} is not valid base64`);
  }
  return compact;
}

/**
 * 校验文档中唯一 Signature 的结构，并用给定 RSA 公钥验签。
 * 全部检查通过才返回；任何一步失败都抛出 Error。
 * KeyInfo 若存在仅被忽略，绝不作为信任来源。
 */
export function verifyDocumentSignature(
  doc: XmlDocument,
  root: XmlElement,
  rootId: string,
  publicKeyPem: string,
): void {
  // 全篇唯一 Signature，且必须是根的直接子元素。
  const signatures = [...iterateElements(doc.root)].filter(
    (el) => el.namespaceURI === NS_XMLDSIG && el.localName === 'Signature',
  );
  if (signatures.length !== 1) {
    fail(`document must contain exactly one Signature, found ${signatures.length}`);
  }
  const signature = signatures[0]!;
  if (signature.parent !== root) {
    fail('Signature must be a direct child of the root element');
  }

  const signatureChildren = childElements(signature);
  if (
    signatureChildren.length < 2 ||
    signatureChildren[0]!.namespaceURI !== NS_XMLDSIG ||
    signatureChildren[0]!.localName !== 'SignedInfo' ||
    signatureChildren[1]!.namespaceURI !== NS_XMLDSIG ||
    signatureChildren[1]!.localName !== 'SignatureValue'
  ) {
    fail('Signature must start with SignedInfo followed by SignatureValue');
  }
  const signedInfo = signatureChildren[0]!;
  const signatureValueEl = signatureChildren[1]!;

  // SignedInfo: 恰为 CanonicalizationMethod, SignatureMethod, Reference。
  const siChildren = childElements(signedInfo);
  if (
    siChildren.length !== 3 ||
    siChildren[0]!.localName !== 'CanonicalizationMethod' ||
    siChildren[0]!.namespaceURI !== NS_XMLDSIG ||
    siChildren[1]!.localName !== 'SignatureMethod' ||
    siChildren[1]!.namespaceURI !== NS_XMLDSIG ||
    siChildren[2]!.localName !== 'Reference' ||
    siChildren[2]!.namespaceURI !== NS_XMLDSIG
  ) {
    fail('SignedInfo must contain exactly CanonicalizationMethod, SignatureMethod, Reference');
  }
  const [c14nMethod, signatureMethod, reference] = siChildren as [
    XmlElement,
    XmlElement,
    XmlElement,
  ];

  requireAlgorithm(c14nMethod, ALG_EXC_C14N, 'CanonicalizationMethod');
  const c14nPrefixList = readPrefixList(c14nMethod, 'CanonicalizationMethod');

  requireAlgorithm(signatureMethod, ALG_RSA_SHA256, 'SignatureMethod');
  if (childElements(signatureMethod).length !== 0) {
    fail('SignatureMethod must not have element children');
  }

  // Reference: URI 按字面等于 "#" + 根元素 ID。
  if (getAttribute(reference, 'URI') !== `#${rootId}`) {
    fail('Reference URI must literally match the root element ID');
  }
  const refChildren = childElements(reference);
  if (
    refChildren.length !== 3 ||
    refChildren[0]!.localName !== 'Transforms' ||
    refChildren[0]!.namespaceURI !== NS_XMLDSIG ||
    refChildren[1]!.localName !== 'DigestMethod' ||
    refChildren[1]!.namespaceURI !== NS_XMLDSIG ||
    refChildren[2]!.localName !== 'DigestValue' ||
    refChildren[2]!.namespaceURI !== NS_XMLDSIG
  ) {
    fail('Reference must contain exactly Transforms, DigestMethod, DigestValue');
  }
  const [transforms, digestMethod, digestValueEl] = refChildren as [
    XmlElement,
    XmlElement,
    XmlElement,
  ];

  // 变换序列：恰为 enveloped-signature 后接不含注释的 Exclusive C14N。
  const transformList = findChildren(transforms, NS_XMLDSIG, 'Transform');
  if (
    transformList.length !== 2 ||
    childElements(transforms).length !== 2
  ) {
    fail('Transforms must contain exactly two Transform elements');
  }
  const [enveloped, excC14n] = transformList as [XmlElement, XmlElement];
  requireAlgorithm(enveloped, ALG_TRANSFORM_ENVELOPED, 'Transform');
  if (childElements(enveloped).length !== 0) {
    fail('enveloped-signature Transform must not have element children');
  }
  requireAlgorithm(excC14n, ALG_EXC_C14N, 'Transform');
  const refPrefixList = readPrefixList(excC14n, 'Transform');

  requireAlgorithm(digestMethod, ALG_DIGEST_SHA256, 'DigestMethod');
  if (childElements(digestMethod).length !== 0) {
    fail('DigestMethod must not have element children');
  }

  // 摘要：对根子树施加 enveloped-signature + Exclusive C14N 后计算 SHA-256。
  const canonical = canonicalize(root, {
    inclusivePrefixes: refPrefixList,
    skip: signature,
  });
  const actualDigest = createHash('sha256').update(canonical, 'utf8').digest('base64');
  if (actualDigest !== decodeBase64Text(digestValueEl, 'DigestValue')) {
    fail('digest mismatch: the signed content does not match the request');
  }

  // 签名：对规范化后的 SignedInfo 用受信 RSA 公钥验签。
  const canonicalSignedInfo = canonicalize(signedInfo, {
    inclusivePrefixes: c14nPrefixList,
  });
  const signatureBytes = Buffer.from(
    decodeBase64Text(signatureValueEl, 'SignatureValue'),
    'base64',
  );
  let publicKey;
  try {
    publicKey = createPublicKey(publicKeyPem);
  } catch {
    fail('trusted public key cannot be loaded');
  }
  const ok = cryptoVerify(
    'RSA-SHA256',
    Buffer.from(canonicalSignedInfo, 'utf8'),
    publicKey,
    signatureBytes,
  );
  if (!ok) {
    fail('signature verification failed');
  }
}
