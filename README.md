# approval-adjudicator

企业数据网关批量纠错的多人会签裁决库。由上层调用，状态保存在 SQLite
（使用 Node.js 内置 `node:sqlite`，无原生编译依赖）。

## 要求

- Node.js >= 22.5（内置 `node:sqlite`）

## 使用

```bash
npm install
npm test
```

```ts
import { ApprovalService } from 'approval-adjudicator';

const svc = new ApprovalService('state.db'); // 或 ':memory:'

// 提交工单：1~5 个顺序阶段，每轮有效期 24 小时
svc.submitTicket({
  ticketId: 'ticket-1',
  stages: [
    { approvers: ['a', 'b'], escalatedApprovers: ['x'] },
    { approvers: ['c'], escalatedApprovers: ['y'] },
  ],
  now: Date.now(),
});

// 提交审批决定（重投同一 decisionId 返回首次受理结论）
const result = svc.submitDecision({
  ticketId: 'ticket-1',
  stageIndex: 0,
  round: 'normal', // 或 'escalated'
  approver: 'a',
  decisionId: 'd-1',
  approve: true,
  now: Date.now(),
});

// 推进业务时间：所有未结束工单兑现到期转换
svc.advanceTime(Date.now());

// 查看工单（先落实截至该时刻的到期转换）
const view = svc.getTicket('ticket-1', Date.now());

svc.close();
```

## 语义要点

- 当前轮内每人首次有效决定生效，不能改票；全员同意过阶段，任一驳回整单驳回。
- 普通轮到期切升级轮（清空已有同意，升级组重新会签）；升级轮到期整单超时。
- 到期与决定同一毫秒时先处理到期；升级轮从普通轮原截止时刻起算；
  一次跨过两个截止时刻直接超时。
- 决定标识在工单内唯一；重投返回首次受理结论，不重复计票，重开数据库后依然成立。
- 所有公共方法同步且在单事务内完成，同进程并发调用等价于某个逐项执行顺序。
