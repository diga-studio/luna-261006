import type { TrustedApp, VerifyInput, VerifyResult } from './types.js';
import { parseXml } from './parser.js';
import { verifyDocumentSignature } from './signature.js';
import {
  findChildren,
  getAttribute,
  iterateElements,
  textContent,
} from './model.js';
import {
  MAX_XML_BYTES,
  NS_SAML_ASSERTION,
  NS_SAML_PROTOCOL,
} from './namespaces.js';

const ID_LOCAL_NAMES = new Set(['ID', 'Id', 'id']);

function fail(message: string): never {
  throw new Error(message);
}

function findTrustedApp(
  trustedApps: readonly TrustedApp[],
  entityId: string,
): TrustedApp {
  const app = trustedApps.find((a) => a.entityId === entityId);
  if (app === undefined) {
    fail('Issuer does not match any trusted application');
  }
  return app;
}

/**
 * 校验 HTTP-POST 绑定的 SAML 2.0 AuthnRequest。
 * 只有签名确实保护最终采用的请求内容时才返回 ok:true；
 * 任何一步失败都整体拒绝，不返回部分可信字段。
 */
export function verifyAuthnRequest(input: VerifyInput): VerifyResult {
  try {
    if (Buffer.byteLength(input.xml, 'utf8') > MAX_XML_BYTES) {
      fail('request exceeds the 256 KiB size limit');
    }

    const doc = parseXml(input.xml);
    const root = doc.root;

    if (root.namespaceURI !== NS_SAML_PROTOCOL || root.localName !== 'AuthnRequest') {
      fail('root element must be AuthnRequest in the SAML protocol namespace');
    }
    if (getAttribute(root, 'Version') !== '2.0') {
      fail('Version must be "2.0"');
    }
    const id = getAttribute(root, 'ID');
    if (id === undefined || id === '') {
      fail('AuthnRequest must have a non-empty ID attribute');
    }

    // 全文所有局部名为 ID/Id/id 的属性值必须唯一（含带命名空间的属性）。
    const seenIds = new Set<string>();
    for (const el of iterateElements(root)) {
      for (const attr of el.attributes) {
        if (ID_LOCAL_NAMES.has(attr.localName)) {
          if (seenIds.has(attr.value)) {
            fail('duplicate ID attribute value in document');
          }
          seenIds.add(attr.value);
        }
      }
    }

    // 根下恰有一个断言命名空间下的直接子 Issuer。
    const issuers = findChildren(root, NS_SAML_ASSERTION, 'Issuer');
    if (issuers.length !== 1) {
      fail('AuthnRequest must contain exactly one Issuer');
    }
    const entityId = textContent(issuers[0]!);
    const app = findTrustedApp(input.trustedApps, entityId);

    if (getAttribute(root, 'Destination') !== input.destination) {
      fail('Destination does not match this gateway');
    }
    const acsUrl = getAttribute(root, 'AssertionConsumerServiceURL');
    if (acsUrl === undefined || !app.callbackUrls.includes(acsUrl)) {
      fail('AssertionConsumerServiceURL is not in the application callback list');
    }

    // 用 Issuer 对应应用的受信公钥验证签名；签名必须保护这个根请求本身。
    verifyDocumentSignature(doc, root, id, app.publicKeyPem);

    return {
      ok: true,
      id,
      entityId,
      assertionConsumerServiceUrl: acsUrl,
    };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
