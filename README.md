# ThinLink 主机维护迁移内核

进程内 TypeScript 库，状态全部驻内存。管理主机生命周期（在线 / 迁出中 / 维护中）、
会话归属与容量，以及迁移准备的预占与提交。

## 使用

```ts
import { MigrationKernel } from './src';

const kernel = new MigrationKernel(
  [{ hostId: 'h1', cpu: 8, memory: 16 }],      // 主机容量
  [{ poolId: 'web', cpu: 2, memory: 4 }],      // 池规格：每会话固定消耗
);

const sid = kernel.admit('web', 'h1');          // 容量不足返回 null
const ok = await kernel.prepareMigration('a1', sid!, 'h1', 'h2');
kernel.drain('h1');                             // 'success' | 'blocked'
kernel.close(sid!);                             // 幂等
const snap = kernel.snapshot();                 // 只读快照
```

## 不变式

- 每个未关闭会话恰有一个归属主机。
- 准备期间会话仍属源主机并占用源容量，同时预占目标容量。
- 每台主机：归属会话用量 + 有效迁入预占，在 CPU / 内存两维均不超过容量。
- 仍有效的成功准备提交归属交接；失败不改变源归属。
- 维护中主机不保有会话或预占。
- 关闭源会话、目标进入迁出中，立即作废未提交准备并释放目标预占。

## 构建与测试

```sh
npm install
npm test
```

仅依赖 Node.js（内置 `node:test`）与 devDependency `typescript`。
