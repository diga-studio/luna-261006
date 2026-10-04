# disposable-email-domain-checker

一次性邮箱域名判定库（TypeScript）。域名表及其修订信息存于 SQLite，
检查结果逐行返回给调用方。供上层名单处理程序调用。

## 要求

- Node.js >= 22.5（使用内置 `node:sqlite` 与 `node:test`，无原生模块、无外部服务）
- `npm install` 后 `npm test` 即可构建并运行全部测试

## 使用

```ts
import { DisposableDomainService } from "disposable-email-domain-checker";

const service = new DisposableDomainService("domains.sqlite");

// 整份替换导入（可分段），修订号为调用方提供的唯一正整数
service.beginImport(1);
service.importChunk(1, ["trash.test", "münchen.de"]);
service.importChunk(1, ["xn--nxasmq6b.example"]);
service.commitImport(1); // 只有完整导入成功的修订才生效

// 受理批次：受理确认时即固定当时生效的修订，整批不混用修订
const batch = service.beginBatch();
const result = batch.check("user@a.trash.test");
// => { line, domain: "a.trash.test", disposable: true, matchedRule: "trash.test", revision: 1 }
batch.finish(); // 或 batch.cancel()：已交付结果不撤回，之后不再交付

service.close();
```

## 语义

- **归一化**：UTS46 非过渡模式 + STD3 规则，ASCII 小写，允许并忽略一个末尾根点。
  Unicode 域名与对应 Punycode 等价；ß 与 ss 不等价。
- **匹配**：规则命中自身及所有子域，只在完整标签边界匹配；
  多条命中时返回标签最多者；归一化后重复的规则视为一条。
- **修订**：初始生效修订为 0（空表）。每次导入整份替换；
  当前表始终对应已成功导入的最大修订号，晚完成的旧修订不会回滚新表。
- **批次**：受理时固定修订，从首行到末行不混用；支持取消。
- **回收**：批次结束或取消后释放对旧修订的占用；
  已失效且无人使用的修订自动回收，仍被使用的修订保持可读。
