import {
  createHash,
  createPublicKey,
  createSign,
  generateKeyPairSync,
  type KeyObject,
} from 'node:crypto';
import { canonicalize } from '../src/c14n.js';
import type { XmlElement } from '../src/model.js';
import {
  findChildren,
  getAttribute,
  iterateElements,
  qualifiedName,
} from '../src/model.js';

function stripNamespaceDecl(el: XmlElement, prefix: string): void {
  const mutable = el as unknown as {
    namespaceDeclarations: { prefix: string; uri: string }[];
  };
  mutable.namespaceDeclarations = mutable.namespaceDeclarations.filter(
    (d) => d.prefix !== prefix,
  );
}

/** 按无命名空间 ID 属性查找元素（测试构造用）。 */
export function findElementById(
  root: XmlElement,
  id: string,
): XmlElement | undefined {
  for (const el of iterateElements(root)) {
    if (getAttribute(el, 'ID') === id) {
      return el;
    }
  }
  return undefined;
}
import {
  ALG_DIGEST_SHA256,
  ALG_EXC_C14N,
  ALG_RSA_SHA256,
  ALG_TRANSFORM_ENVELOPED,
  NS_XMLDSIG,
} from '../src/namespaces.js';
import { parseXml } from '../src/parser.js';

export const GATEWAY_DESTINATION = 'https://gateway.example.com/saml/acs';

export interface TestApp {
  entityId: string;
  publicKeyPem: string;
  privateKey: KeyObject;
  callbackUrls: string[];
}

export function makeApp(entityId: string, callbackUrls: string[]): TestApp {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  return {
    entityId,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey,
    callbackUrls,
  };
}

export function trustedDir(
  apps: readonly { entityId: string; publicKeyPem: string; callbackUrls: string[] }[],
) {
  return apps.map((a) => ({
    entityId: a.entityId,
    publicKeyPem: a.publicKeyPem,
    callbackUrls: a.callbackUrls,
  }));
}

function escapeText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function escapeAttribute(value: string): string {
  return escapeText(value).replaceAll('"', '&quot;');
}

/** 将内部节点模型序列化回 XML 文本（测试构造用，非规范化）。 */
export function serialize(el: XmlElement): string {
  let out = `<${qualifiedName(el)}`;
  for (const decl of el.namespaceDeclarations) {
    out +=
      decl.prefix === ''
        ? ` xmlns="${escapeAttribute(decl.uri)}"`
        : ` xmlns:${decl.prefix}="${escapeAttribute(decl.uri)}"`;
  }
  for (const attr of el.attributes) {
    const name = attr.prefix === '' ? attr.localName : `${attr.prefix}:${attr.localName}`;
    out += ` ${name}="${escapeAttribute(attr.value)}"`;
  }
  out += '>';
  for (const child of el.children) {
    switch (child.kind) {
      case 'element':
        out += serialize(child);
        break;
      case 'text':
        out += escapeText(child.value);
        break;
      case 'cdata':
        out += `<![CDATA[${child.value}]]>`;
        break;
      case 'comment':
        out += `<!--${child.value}-->`;
        break;
      case 'pi':
        out += child.data === '' ? `<?${child.target}?>` : `<?${child.target} ${child.data}?>`;
        break;
    }
  }
  out += `</${qualifiedName(el)}>`;
  return out;
}

export interface SignRequestOptions {
  privateKey: KeyObject;
  /** 默认 "#" + 根元素 ID。 */
  referenceUri?: string;
  /** SignedInfo 的 InclusiveNamespaces PrefixList。 */
  c14nPrefixList?: string;
  /** Reference 变换的 InclusiveNamespaces PrefixList。 */
  refPrefixList?: string;
  /** 插入到 SignatureValue 之后的原始 XML（如 KeyInfo）。 */
  extraSignatureInnerXml?: string;
  /** 摘要计算目标的元素 ID：默认对文档根计算（攻击样例可指向嵌套元素）。 */
  digestTargetId?: string;
  /** 为 true 时 Signature/SignedInfo 不重复声明 ds 前缀（依赖祖先声明）。 */
  inheritDsNamespace?: boolean;
}

function inclusiveNamespacesXml(prefixList: string | undefined): string {
  if (prefixList === undefined) {
    return '';
  }
  return `<ec:InclusiveNamespaces xmlns:ec="${ALG_EXC_C14N}" PrefixList="${prefixList}"/>`;
}

/**
 * 以真实 RSA-SHA256 签名构造带 ds:Signature 的 XML：
 * 计算根（或指定目标）的 enveloped + Exclusive C14N 摘要，
 * 在文档上下文中规范化 SignedInfo 后签名。
 */
export function signRequest(xml: string, options: SignRequestOptions): string {
  const doc = parseXml(xml);
  const root = doc.root;
  const id = getAttribute(root, 'ID');
  if (id === undefined) {
    throw new Error('test input must have an ID');
  }
  const referenceUri = options.referenceUri ?? `#${id}`;

  let digestTarget = root;
  if (options.digestTargetId !== undefined) {
    const found = findElementById(root, options.digestTargetId);
    if (found === undefined) {
      throw new Error('test input has no element with the requested ID');
    }
    digestTarget = found;
  }
  const digest = createHash('sha256')
    .update(
      canonicalize(digestTarget, {
        ...(options.refPrefixList !== undefined
          ? { inclusivePrefixes: options.refPrefixList.split(/\s+/) }
          : {}),
      }),
      'utf8',
    )
    .digest('base64');

  const dsDecl = ` xmlns:ds="${NS_XMLDSIG}"`;
  const signedInfoXml =
    `<ds:SignedInfo${dsDecl}>` +
    `<ds:CanonicalizationMethod Algorithm="${ALG_EXC_C14N}">` +
    inclusiveNamespacesXml(options.c14nPrefixList) +
    `</ds:CanonicalizationMethod>` +
    `<ds:SignatureMethod Algorithm="${ALG_RSA_SHA256}"/>` +
    `<ds:Reference URI="${referenceUri}">` +
    `<ds:Transforms>` +
    `<ds:Transform Algorithm="${ALG_TRANSFORM_ENVELOPED}"/>` +
    `<ds:Transform Algorithm="${ALG_EXC_C14N}">` +
    inclusiveNamespacesXml(options.refPrefixList) +
    `</ds:Transform>` +
    `</ds:Transforms>` +
    `<ds:DigestMethod Algorithm="${ALG_DIGEST_SHA256}"/>` +
    `<ds:DigestValue>${digest}</ds:DigestValue>` +
    `</ds:Reference>` +
    `</ds:SignedInfo>`;

  const signatureXml =
    `<ds:Signature${dsDecl}>` +
    signedInfoXml +
    `<ds:SignatureValue></ds:SignatureValue>` +
    (options.extraSignatureInnerXml ?? '') +
    `</ds:Signature>`;

  const signature = parseXml(signatureXml).root;
  const signedInfo = findChildren(signature, NS_XMLDSIG, 'SignedInfo')[0]!;
  if (options.inheritDsNamespace) {
    // 移除 Signature 与 SignedInfo 上的 ds 声明，改依赖根元素上的祖先声明。
    stripNamespaceDecl(signature, 'ds');
    stripNamespaceDecl(signedInfo, 'ds');
  }
  signature.parent = root;
  root.children.push(signature);

  const canonicalSignedInfo = canonicalize(signedInfo, {
    ...(options.c14nPrefixList !== undefined
      ? { inclusivePrefixes: options.c14nPrefixList.split(/\s+/) }
      : {}),
  });
  const signatureValue = createSign('RSA-SHA256')
    .update(canonicalSignedInfo, 'utf8')
    .sign(options.privateKey, 'base64');
  const signatureValueEl = findChildren(signature, NS_XMLDSIG, 'SignatureValue')[0]!;
  signatureValueEl.children.push({ kind: 'text', value: signatureValue });

  return serialize(root);
}

/** 从公钥构造 ds:KeyInfo 文本（仅用于攻击样例）。 */
export function keyInfoXml(publicKeyPem: string): string {
  const jwk = createPublicKey(publicKeyPem).export({ format: 'jwk' }) as {
    n: string;
    e: string;
  };
  const toB64 = (u: string) => Buffer.from(u, 'base64url').toString('base64');
  return (
    `<ds:KeyInfo xmlns:ds="${NS_XMLDSIG}"><ds:KeyValue><ds:RSAKeyValue>` +
    `<ds:Modulus>${toB64(jwk.n)}</ds:Modulus><ds:Exponent>${toB64(jwk.e)}</ds:Exponent>` +
    `</ds:RSAKeyValue></ds:KeyValue></ds:KeyInfo>`
  );
}

