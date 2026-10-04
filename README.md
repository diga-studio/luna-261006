# EdgeForge 网关本地部署管理库

工厂网关的本地部署管理库（TypeScript，由上层直接调用）。发布记录存 SQLite，
流水线配置与模型文件存本地目录，生效记录为独立于 SQLite 的指针文件。

## 环境要求

- Node.js >= 23.4（推荐 24 LTS；使用内置 node:sqlite，无原生依赖、无外部服务）
- npm install && npm test 即可构建并运行全部测试

## API

```ts
import { GatewayManager } from "edgeforge-gateway-manager";

const manager = new GatewayManager(dataDir); // 每个实例管理一个网关，调用串行执行

// 1. 发布整包：sourceDir 为调用方提供的完整本地输入目录（含流水线 JSON 与模型文件，
//    模型最大 100MB）。正常返回后该目录可立即删除。
manager.publish({ requestId: "req-1", sourceDir: "/path/to/package" });

// 2. 报告推理结果：携带运行代次、毫秒时间、成功或失败。
manager.reportInference({ requestId: "req-2", generation: 1, timestamp: 1700000000000, success: false });

// 3. 恢复并查看状态：进程重启后先恢复（构造函数也会自动恢复），再查看状态。
manager.recover();
const status = manager.getStatus();
```

## 持久化布局（dataDir）

- edgeforge.db：SQLite，存发布记录、淘汰标记、请求去重、推理报告、当前状态
- releases/<id>/：每次发布的完整包副本（先写暂存目录、fsync、原子重命名）
- active.json：生效记录（运行代次 + 当前发布），临时文件 + 原子重命名切换

## 崩溃一致性

- 发布与回退的业务效果以 SQLite 事务为提交点；生效记录是已提交状态的镜像。
- 进程在任意持久化边界退出后，恢复时清理暂存残留、移除无记录的包目录，
  并把生效记录对齐到 SQLite 中已提交的状态。
- 相同请求标识的重试直接返回首次处理结果，不产生第二次业务效果。

## 自动回退规则

- 最近 3 次有效报告全部失败，且首尾时间差不超过 300000ms（恰好 300000ms 也算）时触发。
- 成功报告打断连续失败；只统计当前运行代次的报告；重启不清空失败证据。
- 回退淘汰当前发布，逆序选择更早的最近一个未淘汰发布；无候选则停止运行。
