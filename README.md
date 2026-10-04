# task26100627

进程内采购三方对账组件（TypeScript）：连接 PO 约定价、分批验收与发票付款授权。

## 使用

```bash
npm install
npm test
```

## API

- `new Reconciler(poLines)` — 初始化不可变 PO 行及单价（整数美分，USD）。
- `setReceipt(receiptId, poLineId, approvedQty)` — 新增验收记录或更正批准数量（允许为 0）。
  已有记录不能改所属 PO 行；低于已授权数量则整次失败且状态不变；占用仍超额时按对账尝试
  开始顺序从新到旧使待复核发票整单失效，并释放其在其他验收记录上的全部预占。
- `reconcile(invoiceId, lines, review)` — 异步对账。按验收记录首次创建顺序分配未占用数量；
  数量不足整单失败且不调用 review。同一 PO 行合并计算价差，绝对差严格大于
  `max(5000, 期望金额5%)` 才复核；复核通过才授权，拒绝或抛错整单释放，可重试。
- `snapshot()` — 返回验收数量、预占/已授权占用与发票状态，用于核对占用关系。
