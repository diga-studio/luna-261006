# counterfeit-image-blacklist

假货图片黑名单核验库（TypeScript）。黑名单保存在进程内存中，由上层商品审查流程直接调用。
图片的感知哈希（64 位，16 位十六进制文本）由上游计算，本库不处理图片文件。

## 使用

```ts
import { BlacklistVerifier } from "counterfeit-image-blacklist";

const verifier = new BlacklistVerifier();

// 批量录入（evidenceId 已存在时替换旧哈希）
verifier.addBatch([
  { evidenceId: 1001, hash: "9e4c1f02a3b4c5d6" },
  { evidenceId: 1002, hash: "0123456789abcdef" },
]);

// 批量核验：命中返回 { evidenceId, distance }，未命中返回 null
const results = verifier.verifyBatch(["9e4c1f02a3b4c5d7", "ffffffffffffffff"]);
// results[0] = { evidenceId: 1001, distance: <=6 的精确汉明距离 }
// results[1] = null（不存在距离 <= 6 的记录时）

// 批量移除（未知编号忽略，重复移除无影响）
verifier.removeBatch([1001]);
```

核验规则：两个 64 位哈希的汉明距离（全部 64 位，含最高位）不超过 6 为命中；
每张待查图片只返回一个可引用证据——距离最小者优先，距离相同取编号最小者；
结果为精确计算，不使用近似。

## 设计

- 64 位哈希按位交错分成 8 个 8 位波段（第 i 位归入第 i % 8 个波段），
  任意连续 16 位都会均匀分摊到全部 8 个波段。
- 距离 ≤ 6 的两个哈希，差异位至多落在 6 个波段，因此至少 2 个波段完全一致。
  查询时统计每条记录在多少个波段桶中与查询重合，只对达到 2 次的候选做精确
  汉明距离计算——结果精确，且在“共享高 16 位”的聚类数据上不会退化。
- 记录使用稠密内部编号，哈希、证据编号、波段槽位都放在定长类型化数组中；
  波段桶为可增长的 `Uint32Array`，录入/替换/移除均为 O(1) 均摊。
- 查询期计数采用纪元标记（epoch tagging），无需逐查询重置。

## 构建与测试

```sh
npm install
npm test
```

只依赖 `typescript` 一个开发依赖；测试使用 Node 内置的 `node:test`，
不需要任何外部服务。

测试内容：

- `test/correctness.test.ts`：距离 6/7 边界、最高位参与比较、最近证据优先于
  最小编号、同距离取最小编号、替换/移除后与当前有效黑名单的全量精确计算一致
  （含多编号共享哈希、删除最后一个共享编号）、两种数据分布下的随机模糊对照。
- `test/perf.test.ts`：100 万条黑名单、每批 10000 张图片，覆盖“各位分散”与
  “共享高 16 位”两类分布；记录载入耗时、核验耗时与峰值内存，校验已知命中/
  未命中结果，并抽样与全量精确扫描比对。

参考指标（本机实测）：1M 记录载入约 1.1s；10k 查询核验分散分布约 0.8s、
共享高 16 位分布约 3.8s（预算 10s）；进程峰值内存约 460–600 MiB（预算 768 MiB，
含测试框架自身数据）。
