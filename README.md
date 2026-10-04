# x509-signature-review

离线 X.509 签名算法审查库：对证书快照做纯静态分析，标记 SHA-1 风险。
不验证签名值、不校验信任链，全程不访问网络。

## 使用

```ts
import { inspectCertificate, inspectChain } from './src';

const verdict = inspectCertificate(derBytes); // 'SAFE' | 'WEAK' | 'UNKNOWN' | 'INVALID'
const allSafe = inspectChain([cert1, cert2]); // 仅当全部为 SAFE 时返回 true
```

判定语义：

- `SAFE`：算法完全识别、内外一致，且主哈希与 MGF1 哈希均不含 SHA-1。
  仅表示通过本次算法审查，不表示证书可信。
- `WEAK`：完全识别且内外一致，但主哈希或 MGF1 哈希含 SHA-1。
- `UNKNOWN`：结构合法，但存在未支持的算法或参数（未知 OID、非 NULL 的
  RSA 参数、非 MGF1 的掩码生成函数、trailerField ≠ 1 等），且内外原始编码一致。
- `INVALID`：DER 结构损坏，或内外签名算法规范化结果不一致。

审查规则：

- 分别读取 `Certificate.signatureAlgorithm` 与 `TBSCertificate.signature`，
  兼容 TBS 中有无 version 字段；公钥与扩展中的 OID 不影响结论。
- 仅支持 RSA 的 SHA-1/SHA-256/SHA-384/SHA-512 签名与 RSASSA-PSS；
  已支持的 RSA 签名及散列 AlgorithmIdentifier 的 NULL 参数与缺省等价。
- PSS 参数必须是 SEQUENCE，显式标签 0–3 依次为 hashAlgorithm、
  maskGenAlgorithm、saltLength、trailerField，缺省值分别为
  SHA-1、MGF1(SHA-1)、20、1；允许显式默认值，比较时补齐。
- 未知 OID 与未支持参数保留原始编码用于内外逐字节比较。

## 构建与测试

```sh
npm install
npm test
```

测试夹具全部由 `test/der-writer.ts` 本地构造，不依赖任何外部文件或服务。
