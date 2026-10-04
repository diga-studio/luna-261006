# disposable-domain-checker

一次性邮箱域名判定库（TypeScript），由上层名单处理程序调用。
域名表及其修订信息存于 SQLite（Node.js 内置 `node:sqlite`，无原生依赖），
检查结果逐行返回给调用方。

## 环境要求

- Node.js >= 22.18（内置 `node:sqlite` 与 TypeScript 类型剥离，测试无需转译器）
- 仅使用 SQLite / 本地文件持久化，不依赖任何外部服务

## 使用

```bash
npm install
npm test        # 构建并运行全部测试
npm run build   # 仅构建到 dist/
```

```ts
import { DisposableDomainService } from "disposable-domain-checker";

const svc = new DisposableDomainService("rules.sqlite");

// 运营侧：整份替换导入，数据可分段到达
const imp = svc.beginImport(42);        // 调用方提供的唯一正整数修订号
imp.addChunk(["trash.test", "münchen.de"]);
imp.addChunk(["junk.mail"]);
imp.commit();                            // 仅完整提交才可能生效

// 名单侧：受理即固定当时生效修订，首行到末行不混用
const batch = svc.acceptBatch();
const r = batch.checkLine("user@a.trash.test");
// { input, disposable: true, matchedRule: "trash.test", revision: 42 }
batch.close();   // 或 batch.cancel()：已交付结果不撤回，之后不再交付

svc.close();
```

## 语义

- **归一化**：UTS46 非过渡模式 + STD3，ASCII 小写，忽略一个末尾根点；
  Unicode 域名与对应 Punycode 等价，`ß` 与 `ss` 不等价。
- **匹配**：规则命中自身及所有子域，仅完整标签边界；多规则命中取标签最多者；
  归一化后重复的规则视为一条。
- **修订**：初始生效修订为 0（空表）。每次导入整份替换；只有完整导入成功的
  修订才可生效；当前表始终是已成功导入中的最大修订号，晚完成的旧修订不回滚。
- **批次**：受理确认时固定当时生效修订；批次正常结束或取消后释放占用；
  失效且无人使用的修订自动回收，仍被占用的修订保持可读。

## 结构

- `src/normalize.ts` — 域名归一化与行内域名提取
- `src/store.ts` — SQLite 持久层：规则、修订状态、批次引用计数与回收
- `src/service.ts` — 对外服务：导入会话与批次受理
- `src/types.ts` — 公开类型（`CheckResult` / `ImportSession` / `Batch`）
- `test/` — node:test 自动化测试
