# VaultChat

本地加密消息检索库（TypeScript + SQLite）。

- 正文使用 AES-256-GCM 随机化认证加密，32 字节密钥由调用方提供，绝不落盘。
- 检索通过依赖密钥的 HMAC 内容标记完成，持久化内容不含明文正文、规范化正文或明文查询；
  检索信息泄露限于长度、相等关系与位置。
- 关闭后可用同一密钥重新打开（密钥不匹配会抛错）。

## 要求

- Node.js >= 23.4（使用内置 `node:sqlite`，无任何原生/运行时依赖）。
- `npm install` 后 `npm test` 即可运行全部测试。

## API

```ts
import { VaultChat } from "vaultchat";

const vc = new VaultChat({ path: "vault.db", key }); // key: 32 字节 Uint8Array

const id = vc.append("conversation-id", "消息正文"); // 返回全库递增的消息 ID

vc.recall(id); // 使消息不可检索，但保留原始密文

// 搜索指定会话中的未撤回消息，按 ID 倒序，cursor 翻页
let page = vc.search(["conversation-id"], "查询词", 20);
while (page.cursor !== null) {
  page = vc.search(["conversation-id"], "查询词", 20, page.cursor);
}

vc.close();
```

## 搜索语义

- 规范化固定为：先 NFC，再 `toLowerCase()`，再 NFC（正文与查询同样处理）。
- 匹配为连续子串，不分词；空格、标点、中文、非 BMP 字符都参与匹配。
- 结果按消息 ID 倒序；同一分页期间假定没有写入或撤回，翻页不重复、不遗漏。

## 脚本

- `npm run build`：编译到 `dist/`。
- `npm test`：编译并运行 `node --test` 全部测试。
