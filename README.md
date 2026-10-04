# task26100627

进程内采购三方对账组件（TypeScript）：连接 PO 约定价、分批验收与发票付款授权。

## 规则概要

- 只处理 USD，金额一律为整数美分；发票数量为正整数，验收批准数量可为零。
- PO 行及单价在构造时给定且不可变。
- 任意时刻，每条验收记录 `已授权数量 + 有效预占数量 <= 当前批准数量`。
- 一张发票的全部行一起预占、一起授权、一起释放；每份占用可追溯到具体验收记录。
- 同一发票内相同 PO 行的条目合并后计算价差：`|实际 - 期望|` 严格大于
  `max(5000, 期望 * 5%)` 时才触发人工复核；等于阈值不触发。
- 数量不足时整单失败且不调用 review；需复核时先预占整单，再调用一次 `review(report)`。
- 验收更正：低于已授权数量则整次失败且状态不变；否则超额时按对账尝试开始顺序
  从新到旧使待复核发票逐张整单失效（跨 PO 行的预占一并释放）。
- 同一 invoiceId 内容固定；拒绝或失效后允许重试；已授权发票不可重复对账。

## API

```ts
const rec = new Reconciler([{ poLineId: "A", unitPriceCents: 1000 }]);
rec.setReceipt("r1", "A", 10);                    // 新增或更正验收记录
const status = await rec.reconcile("inv-1", lines, review); // 对账并尝试授权
const state = rec.snapshot();                     // 验收数量与占用关系
```

`reconcile` 返回最终状态：`authorized` / `pending_review`（仅理论上的并发场景）/
`rejected` / `invalidated`。

## 构建与测试

```sh
npm install
npm test
```

只依赖 Node.js 与 `npm install` 安装的 TypeScript 编译器；测试使用 Node 内置
`node:test`，不启动任何端口或服务。
