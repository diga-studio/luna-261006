# sentinelvault-crypt

供 SentinelVault 上层调用的原地文件加密库：文件保留在本地原路径，任务记录存 SQLite，进程在任意时刻被终止后均可凭批次标识与密钥安全续跑。

## 能力

- `submitBatch(batchId, files, key, options)` — 提交或续跑批次。同一 `batchId` 的重试必须使用相同清单与 32 字节密钥（库会校验，不匹配则抛 `BatchConflictError`）。已完成的文件逐字节不动，未完成的继续处理。
- `getProgress(batchId, key, options)` — 查询进度，结果与磁盘实际状态对账：目标文件已是本批次最终密文才算完成。
- `readPlaintext(batchId, filePath, key, options)` — 验证完整性后读回已完成文件的原始字节；验证失败抛 `IntegrityError`，不返回任何明文。

`options.stateDir` 指定 SQLite 任务库所在目录；密钥不持久化。

## 设计

- **密文容器**：`MAGIC(8) | batchTag(16) | fileTag(16) | nonce(12) | AES-256-GCM(明文) | GCM tag(16)`，头部作为 AAD。`batchTag`/`fileTag` 由密钥与批次标识 HMAC 派生，恢复时只需读文件头 52 字节即可识别"本批次最终密文"，因此旧批次的有效密文在新批次中会被当作普通原文再加密一层。
- **崩溃安全**：每个文件先写同目录临时文件（分块写 + fsync），再原子 rename 覆盖目标，fsync 目录后持久化完成记录。任意时刻终止，目标路径只会是完整原文或完整最终密文；遗留临时文件在续跑时自动清理。
- **记录对账**：完成记录先于崩溃丢失时，续跑/查询通过文件头识别已完成文件并补记，密文字节不再变动。
- **限制**：每批 ≤ 500 个文件，每个 ≤ 8 MiB，串行处理。

## 构建与测试

```sh
npm install
npm test
```

只依赖 Node.js（>= 22.5，使用内置 `node:sqlite`）与 devDependencies 中的 `typescript`、`@types/node`，不需要 Docker 或任何外部服务。

## 测试覆盖

- 密文写到一半时 SIGKILL：遗留截断临时文件，续跑完成后无残留。
- rename 完成但完成记录未持久化时 SIGKILL：进度与磁盘对账一致，已完成密文逐字节不变。
- 恢复过程中再次 SIGKILL：再次续跑仍可完成。
- 本库有效密文作为新批次普通输入：读回得到该密文本身，不少加密也不多解密。
- 空文件 / 任意二进制往返、完整性破坏拒绝返回明文、密钥或清单不匹配拒绝续跑、输入校验。
