# SecureVault ZIP 入库检查库

对员工上传的 ZIP 压缩包做入库前检查：确认归档只有一套自洽的文件视图，并检查成员名称中的禁用扩展名。文件保留在原位置，不解压落盘，检查结果不持久化。只检查当前这一层归档，不递归检查成员内容；放行不代表文件无毒。

## 用法

```ts
import { checkZipFile } from './src/index.ts';

const result = await checkZipFile('/path/to/upload.zip');
// result.verdict: 'allow' | 'quarantine' | 'review'
// result.reasons: 复核/隔离原因码
// result.bannedHits: 命中的禁用扩展名（隔离时）
```

结论规则：无法完整验证的归档一律 `review`（人工复核）；完整验证后存在禁用扩展名则 `quarantine`（隔离），否则 `allow`（放行）。结构异常优先级高于扩展名命中。

## 检查范围

- 支持：普通单卷 ZIP、空归档、目录、文件/归档注释、Store 与 Deflate、严格 UTF-8 名称（未设 UTF-8 标志时只接受 ASCII）、有/无签名数据描述符。
- 转复核：加密、分卷、ZIP64、其他压缩方式、Unicode Path 改名扩展、名称/长度/CRC 不一致、记录重叠或无归属字节、Deflate 流截断或夹带尾部字节、目录成员非空、超限。
- 限制：单包 ≤ 100 MiB，累计实际展开量 ≤ 128 MiB（恰好等于允许），超限即停止展开并转复核。
- 禁用扩展名：`.exe .dll .com .scr .bat .cmd .ps1`（正/反斜杠均为分隔符，忽略末尾空格与点号，ASCII 大小写不敏感）。

## 构建与测试

```sh
npm install
npm test
```

仅依赖 Node.js（≥ 22.6，建议 24）内置模块；`typescript` 与 `@types/node` 为开发依赖（类型检查）。
