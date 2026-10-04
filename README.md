# btc-sighash

离线 Bitcoin 签名前摘要库（TypeScript）。为上层钱包计算单个输入的待签
double-SHA256 摘要，支持传统（pre-segwit）规则与 BIP143（SegWit v0）。
交易与签名上下文仅保存在内存，不涉及任何密钥存储。

## 安装与测试

```sh
npm install
npm test
```

仅需 Node.js；`typescript` 与 `@types/node` 为 devDependencies，
`npm test` 先编译到 `dist/` 再用内置 `node --test` 运行测试。

## API

```ts
import { computeSignatureDigest } from "btc-sighash";

const digest: Uint8Array = computeSignatureDigest({
  serializedTx,              // 完整序列化交易（传统或带 witness）
  inputIndex: 0,             // 目标输入序号
  mode: "bip143",            // "legacy" | "bip143"
  scriptCode,                // 完整签名脚本（P2WPKH 用展开后的标准脚本）
  prevOutValue: 50_000n,     // 前序输出金额（satoshis，仅 bip143 参与摘要）
  hashType: 0x01,            // ALL/NONE/SINGLE ± ANYONECANPAY 六种组合
  lastCodeSeparatorOffset: null, // 最后执行的 OP_CODESEPARATOR 字节位置或 null
});
```

语义要点：

- `ALL` 承诺全部输出，`NONE` 不承诺输出，`SINGLE` 承诺与目标输入原始
  序号对应的输出；`ANYONECANPAY` 只承诺当前输入，且不会把 `SINGLE` 的
  输出索引改成 0。
- 传统 `SINGLE` 在输入序号不小于输出数量时返回常量 `0x01` 后跟 31 个
  `0x00`；BIP143 相同情形仍正常计算（`hashOutputs` 为零哈希）。
- 脚本承诺从最后执行的 `OP_CODESEPARATOR` 之后开始；传统模式移除剩余
  分隔符指令，BIP143 保留。推入数据中的 `0xab` 字节是数据而非指令。
  偏移若指向推入数据内部会抛错。
- 交易现有的 `scriptSig` 与 witness 不参与摘要；前序金额只参与 BIP143。
- 整数按完整位宽处理（金额为 `bigint`），长度使用 CompactSize 编码。
- 不会修改调用方传入的交易字节或脚本。

辅助导出：`parseTransaction`、`signatureSubscript`、
`encodeCompactSize` / `decodeCompactSize`。

## 测试

`test/sighash.test.ts` 覆盖：两种模式下 `SINGLE` 输出缺位及其
`ANYONECANPAY` 组合（传统返回常量、BIP143 正常摘要）、执行位置前后均有
分隔符且推入数据含 `0xab` 的脚本截取规则、witness/scriptSig 不参与摘要、
调用方数据不被修改、CompactSize 边界、非法输入拒绝等。

期望摘要由独立参考实现 `test/gen_vectors.py` 生成（固化在
`test/vectors.ts`）；该脚本仅用于重新生成向量，不属于 `npm test`。
