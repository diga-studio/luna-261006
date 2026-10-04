# saml-authn-request-verifier

面向统一身份网关（身份提供方）的 SAML 2.0 AuthnRequest 验签库。
只处理 HTTP-POST 绑定：输入为上层完成表单解析与 Base64 解码后的 UTF-8 XML，
输出为可信的请求 ID、应用 entityID 与回调地址。

核心保证：只有签名确实保护了最终采用的请求内容，才返回成功。
仅仅"文档里存在一段有效签名"（例如只保护了嵌套请求）会被拒绝。

## 使用

```ts
import { verifyAuthnRequest } from 'saml-authn-request-verifier';

const result = verifyAuthnRequest({
  xml,                // 表单字段 Base64 解码后的 UTF-8 XML
  trustedApps,        // 受信应用目录（驻留内存，由调用方维护）
  destination: 'https://gateway.example.com/saml/acs', // 本网关的 Destination
});

if (result.ok) {
  // result.id / result.entityId / result.assertionConsumerServiceUrl
  // 全部取自同一个被完整签名的根 AuthnRequest
} else {
  // result.reason 仅供日志诊断，不含任何可用于登录的字段
}
```

受信应用目录条目：

```ts
interface TrustedApp {
  entityId: string;          // 与 Issuer 文本精确匹配
  publicKeyPem: string;      // RSA 公钥（SPKI, PEM）
  callbackUrls: string[];    // AssertionConsumerServiceURL 白名单，精确匹配
}
```

## 校验规则摘要

- 根元素必须是 SAML 协议命名空间下的 `AuthnRequest`，`Version="2.0"`，
  具有非空无命名空间 `ID`；根下恰有一个断言命名空间下的直接子 `Issuer`。
- `Issuer`、`Destination`、`AssertionConsumerServiceURL` 均按解析后的完整
  字符串精确比较，不做 URL 归一化。
- 全篇恰有一个 XMLDSig `Signature` 且为根的直接子元素；`SignedInfo` 恰有一个
  `Reference`，其 `URI` 按字面等于 `#` + 根元素 `ID`；全文所有局部名为
  `ID`/`Id`/`id` 的属性值必须唯一。
- 仅支持 RSA-SHA256 签名、SHA-256 摘要、不含注释的 Exclusive C14N；
  Reference 变换只能依次为 enveloped-signature 与 Exclusive C14N；
  支持 `InclusiveNamespaces PrefixList`（含 `#default`）。
- 验签公钥只来自受信目录（按 `Issuer` 匹配）；`KeyInfo` 仅被忽略。
- 拒绝 DOCTYPE 与实体声明，不读取任何外部资源；单份请求不超过 256 KiB。
- 校验只完整成功或完整拒绝，失败不返回部分可信字段。

本模块不负责登录、会话、请求重放检测或 SAML 响应签发。

## 构建与测试

```sh
npm install
npm test        # 编译 TypeScript 并运行 node:test 测试
npm run build   # 仅编译到 dist/
```

仅依赖 Node.js（>= 18）与 npm 包 `saxes`（严格 XML 解析）；
TypeScript 为开发依赖。测试包含真实 RSA 签名样例（含冻结的已知答案样例）、
包装攻击、回调篡改、重复 ID、KeyInfo 陌生密钥等攻防用例。
