# task26100695

规则依赖图的在线修改库（TypeScript，纯内存，串行调用）。

`A` 依赖 `B` 表示执行 `A` 之前必须执行 `B`。库只维护跨规则引用，
不做条件判定或动作执行；不支持持久化与崩溃恢复。

## API

- `createGraph(rules)`：从完整的初始无环图创建实例，
  每个规则为 `{ id, dependsOn }`。
- `applyBatch({ remove, add })`：原子提交一批引用删除和添加
  （引用 `{ from, to }` 表示 `from` 依赖 `to`）。按先删除后添加得到
  最终引用集合，不暴露中间状态。接受当且仅当整批修改后的最终图无环：
  - 成功：所有修改同时生效，返回 `{ ok: true, stats }`。
  - 失败：图与执行顺序完全保持不变，返回 `{ ok: false, cycle, stats }`，
    其中 `cycle` 是首尾相同的规则 ID 序列，相邻两项都是最终候选图中的
    真实引用（环见证）。
- `snapshot()`：返回当前完整引用集合 `edges` 及一个执行顺序 `order`
  （每条引用的被依赖规则排在使用者之前）。snapshot 不计入访问统计。

`stats` 为每次提交的访问统计（规则、引用、顺序项的实际读取/改写次数，
含复制、重排与回滚）：`ruleReads/ruleWrites/edgeReads/edgeWrites/
orderReads/orderWrites/total`。

## 实现要点

- 内部维护拓扑顺序数组及位置索引；新增引用若与当前顺序一致则 O(1) 接受。
- 否则在受影响的位置区间内做双向 DFS（Pearce-Kelly 风格增量拓扑排序），
  只重排受影响区域，不遍历或复制全图；发现反向可达即得到环见证。
- 批处理先删后增；任一新增成环时按反向日志回滚全部顺序变更与引用变更，
  保证拒绝后状态与提交前完全一致。
- 规模：10 万规则 / 50 万引用，支持 2 万次连续小批提交（每批 ≤ 32 条）。

## 构建与测试

```sh
npm install
npm test
```

只依赖 Node.js（>= 18）与 `typescript`（devDependency），测试使用
Node 内置 `node:test` 运行器。
