/** 受信应用目录条目，由调用方提供并驻留内存。 */
export interface TrustedApp {
  /** 应用唯一 entityID，与 AuthnRequest 的 Issuer 文本精确匹配。 */
  readonly entityId: string;
  /** PEM 格式的 RSA 公钥（SPKI）。 */
  readonly publicKeyPem: string;
  /** 允许的 AssertionConsumerServiceURL 清单，按完整字符串精确匹配。 */
  readonly callbackUrls: readonly string[];
}

export interface VerifyInput {
  /** 上层已完成表单解析与 Base64 解码的 UTF-8 XML 文本。 */
  readonly xml: string;
  /** 受信应用目录。 */
  readonly trustedApps: readonly TrustedApp[];
  /** 网关自身的 Destination。 */
  readonly destination: string;
}

export interface VerifiedAuthnRequest {
  readonly ok: true;
  /** 已验签根请求的 ID。 */
  readonly id: string;
  /** 已验签根请求的 Issuer（应用 entityID）。 */
  readonly entityId: string;
  /** 已验签根请求的 AssertionConsumerServiceURL。 */
  readonly assertionConsumerServiceUrl: string;
}

export interface VerifyFailure {
  readonly ok: false;
  /** 仅供日志诊断，不含任何可用于登录的可信字段。 */
  readonly reason: string;
}

export type VerifyResult = VerifiedAuthnRequest | VerifyFailure;
