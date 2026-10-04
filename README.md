# task26100618

ThinLink 主机维护迁移内核（TypeScript，进程内库，状态驻内存）。

## 使用

```bash
npm install
npm test        # 构建并运行全部自动化测试
npm run build   # 仅编译到 dist/
```

## API 概览

- `new MigrationKernel(config)`：传入主机 CPU/内存容量、池规格；可选 `prepare` 回调模拟目标准备（resolve=成功，reject/抛异常=失败）。
- `admit(poolId, hostId)`：在指定在线主机创建会话，容量不足或非在线则拒绝。
- `close(sessionId)`：关闭会话，幂等；立即作废其未提交准备并释放目标预占与源占用。
- `prepareMigration(attemptId, sessionId, fromHost, toHost)`：异步报告目标准备结果；成功且仍有效时提交归属交接。
- `drain(hostId)`：立即转迁出中并作废迁入预占；本轮每个会话最多迁一次，空了进维护中，否则返回受阻可重试。
- `snapshot()`：只读快照（主机状态/会话归属/实际占用/迁移预占），准备挂起期间亦可观察。
