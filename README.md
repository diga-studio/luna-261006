# btc-sighash

离线 Bitcoin 签名前摘要库（TypeScript），由上层钱包直接调用。交易与签名上下文
仅保存在内存，不涉及任何密钥存储。支持传统（pre-SegWit）与 BIP143（SegWit v0）
两种摘要算法。

## 构建与测试

```sh
npm install
npm test        # 编译 src/ 与 test/，并运行全部测试
npm run build   # 仅编译库到 dist/
```

只依赖 Node.js（>=18）与 devDependencies 中的 typescript / @types/node，
无运行时依赖，不需要任何服务或网络。

## API

```ts
import { signatureDigest, SignatureMode, SIGHASH_ALL } from "btc-sighash";

const digest: Buffer = signatureDigest({
  rawTransaction,            // 序列化交易（传统或带 witness 格式）
  inputIndex: 0,             // 目标输入序号
  mode: SignatureMode.Bip143, // 或 SignatureMode.Legacy
  scriptCode,                // 完整签名脚本（P2WPKH 用展开后的标准脚本）
  prevOutValue: 100000n,     // 前序输出金额（satoshis，仅 BIP143 使用）
  sigHashType: SIGHASH_ALL,  // ALL/NONE/SINGLE 及其 ANYONECANPAY 组合，共六种
  lastCodeSeparatorOffset: null, // 最后执行的 OP_CODESEPARATOR 字节位置，未执行为 null
});
```

- `signatureDigest(context)`：计算一个输入的 32 字节待签摘要，不修改调用方
  传入的任何缓冲区。
- `parseTransaction(raw)`：解析传统或带 witness 的序列化交易。
- `signatureSubscript(scriptCode, lastCodeSeparatorOffset, strip)`：提取签名
  承诺的子脚本。

## 共识规则要点

- 传统 `SIGHASH_SINGLE` 在目标输入序号不小于输出数量时，摘要为首字节 `0x01`
  其余 31 字节 `0x00` 的常量；BIP143 相同情形仍正常计算（`hashOutputs` 为零哈希）。
- `ANYONECANPAY` 只承诺当前输入，且不改变 `SINGLE` 承诺的输出索引。
- 脚本承诺从最后执行的 `OP_CODESEPARATOR` 之后开始；传统模式排除剩余的
  `OP_CODESEPARATOR` 指令，BIP143 保留；推入数据中的同值字节始终按数据保留。
- 交易现有 `scriptSig` 与 witness 不参与新摘要；金额以完整 64 位精度参与
  BIP143 摘要；长度前缀使用 CompactSize 编码。

## 测试

- `test/sighash.test.ts`：两种模式的六种签名类型、SINGLE 输出缺位、witness
  不影响摘要、不可变性、非法输入拒绝等。
- `test/codeseparator.test.ts`：执行位置前后均有分隔符、推入数据含同值字节
  的脚本承诺范围。
- `test/vectors.test.ts` + `test/vectors.json`：已知答案向量，由
  `test/gen_vectors.py` 中的独立 Python 参考实现生成（该脚本不属于
  `npm test`，仅用于重新生成向量）。
