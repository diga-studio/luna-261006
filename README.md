# VaultChat

本地加密消息检索库（TypeScript + SQLite）。路径与 32 字节密钥由调用方提供，
关闭后可用同一密钥重新打开。

## 要求

- Node.js >= 22.5（使用内置 `node:sqlite`，无原生编译依赖）

## 使用

```ts
import { VaultChat } from "vaultchat";

const vault = VaultChat.open("/path/to/chat.db", key); // key: 32 字节 Uint8Array
const id = vault.append("conversation-1", "hello");
vault.recall(id);                                       // 撤回：不可检索，密文保留
let page = vault.search(["conversation-1"], "hello", 20); // 按 ID 倒序
while (page.cursor !== null) {
  page = vault.search(["conversation-1"], "hello", 20, page.cursor);
}
vault.close();
```

## 设计

- **正文加密**：AES-256-GCM，每条消息随机 IV（随机化认证加密）。
  正文按 UTF-16LE 编码后加密，任意 JS 字符串（含孤立代理项）均可无损往返。
- **密钥派生**：调用方 32 字节密钥经 HMAC 分别派生加密子密钥、标记子密钥、
  校验子密钥；密钥本身不落盘。库中存有密钥校验值，重开时密钥不匹配会报错。
- **检索标记**：对规范化正文（NFC → `toLowerCase` → NFC）的每个 UTF-16 码元
  计算 HMAC 标记并顺序存储；查询做同样规范化与标记化后做连续子序列匹配，
  与 `String.prototype.includes` 作用于规范化字符串的语义完全一致。
  检索信息泄露长度、相等关系与位置，不泄露明文正文、规范化正文或明文查询。
- **分页**：游标为上一页最后一条消息的 ID，按 ID 倒序扫描，不重复不遗漏
  （假设同一次分页期间没有写入或撤回）。

## 构建与测试

```sh
npm install
npm test
```
