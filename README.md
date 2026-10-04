# securevault-zip-inspect

SecureVault ZIP 入库检查库。上层传入本地文件路径并取得检查结论；
文件保留在原位置，不解压落盘，检查结果不持久化。只检查当前这一层归档，
不递归检查成员内容，放行不代表文件无毒。

## 用法

```ts
import { inspectZip, inspectZipDetailed } from 'securevault-zip-inspect';

const verdict = await inspectZip('/path/to/upload.zip');
// 'allow' | 'quarantine' | 'review'

const detailed = await inspectZipDetailed('/path/to/upload.zip');
// { verdict, reason }
```

## 结论规则

- `review`（人工复核）：任何无法完整验证的情况——结构异常、加密、分卷、
  ZIP64、不支持的压缩方式、Unicode Path 改名扩展、额外字段边界不完整、
  本地记录与中央目录不一致、数据描述符不符、实际长度或 CRC-32 与声明不符、
  Deflate 流未完整结束或夹带尾部字节、目录成员非空、名称编码不合规、
  超过输入或展开上限等。结构异常优先于扩展名命中。
- `quarantine`（隔离）：完整验证通过后，非目录成员的最后一个名称分量
  （正/反斜杠均为分隔符，去掉末尾连续的 ASCII 空格和点号）的最后一个
  扩展名命中禁用列表 `.exe .dll .com .scr .bat .cmd .ps1`
  （ASCII 大小写不敏感）。
- `allow`（放行）：完整验证通过且无扩展名命中。

## 结构约束

本地记录、中央目录、结束记录（含注释）必须完整、互不重叠地覆盖整个文件；
每条本地记录恰好对应一个中央目录条目（名称原始字节、压缩方式、标志一致，
顺序可不同）；支持有/无签名的数据描述符（含 CRC 恰好等于签名值
0x08074b50 的无签名描述符）。压缩方式仅支持不压缩与 Deflate；
严格 UTF-8 名称，未设 UTF-8 标志时只接受 ASCII 名称。

## 资源上限

- 单包输入：100 MiB
- 全部成员累计实际展开量：128 MiB（恰好等于上限允许；超限即停止展开并转复核，
  以实际计数为准，不依据声明长度）

## 构建与测试

```sh
npm install
npm test
```

只依赖 Node.js 与 devDependencies 中的 TypeScript 工具链。
