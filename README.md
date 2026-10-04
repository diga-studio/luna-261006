# EdgeForge 网关本地部署管理库

工厂网关的本地部署管理：发布整包、报告推理结果、恢复并查看状态。
发布记录存 SQLite，流水线配置与模型文件存本地目录；由上层直接调用，每个实例管理一个网关，所有调用串行执行。

## 环境要求

- Node.js >= 23.4（使用内置 `node:sqlite`，无需任何原生/外部服务依赖）
- `npm install` 后 `npm test` 即可构建并运行全部测试

## API

```ts
import { GatewayManager } from "edgeforge-gateway";

const mgr = await GatewayManager.open("/var/edgeforge/gw-1"); // 打开并自动恢复

// 1) 发布整包：sourceDir 内含 pipeline.json 与 model.bin（≤100MB）。
//    返回后即可删除源目录；相同 requestId 重试返回首次结果。
const pub = await mgr.publish("req-001", "/tmp/pkg-v3");

// 2) 报告推理结果：仅当前运行代次的报告被处理；
//    最近 3 次有效报告全部失败且首尾时间差 ≤ 300000ms 时立即自动回退。
const rep = await mgr.reportInference("req-002", {
  generation: pub.generation,
  timestampMs: Date.now(),
  success: false,
});

// 3) 恢复并查看状态
const status = await mgr.recover();   // 幂等恢复 + 返回状态
const now = mgr.getStatus();          // 只读查看

mgr.close();
```

## 存储布局（工作目录下）

```
edgeforge.db          SQLite：发布记录、淘汰标记、当前代次/发布、请求幂等结果、连续失败证据
releases/<id>/        已提交的发布包（pipeline.json + model.bin，提交后不可变）
staging/              发布中的临时目录，恢复时自动清理
active.json           生效记录：停止运行，或指向完整可读的同一发布包（原子替换写入）
```

## 崩溃安全设计

- SQLite 是唯一业务真源，多步写入全部包在事务里；`active.json` 由真源派生。
- 发布顺序：复制到 `staging/` 并 fsync → 改名为 `releases/<id>` → 事务提交 → 重写生效记录。
  任意边界崩溃后恢复：清理 `staging/` 与无发布记录的孤儿目录，并按真源重写生效记录，
  不会留下半次发布或半次回退，也不会出现配置与模型跨版本混用。
- 已正常返回的操作不会因重启丢失；按原请求标识重试只产生一次业务效果。
- 连续失败证据持久化在 SQLite，重启不清空；进入新运行代次时才重新累计。

## 测试

`npm test` 覆盖：发布/回退在各持久化边界崩溃后恢复重试的唯一性与字节完整性、
300000ms 精确边界、成功打断连续失败、重复报告幂等、旧代次迟到报告、
A→B→C 逐级回退至停止并穿插重启/崩溃后与无中断结果一致等。
