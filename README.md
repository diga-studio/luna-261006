# counterfeit-image-blacklist

进程内存中的假货图片黑名单核验库（TypeScript）。黑名单记录由证据编号（唯一正整数）
和 64 位感知哈希（16 位十六进制文本）组成；核验时返回距离不超过 6 的最优可引用证据，
结果为精确计算，不使用近似索引代替。

## 使用

```ts
import { BlacklistVerifier } from "counterfeit-image-blacklist";

const verifier = new BlacklistVerifier();

// 批量录入 / 替换（evidenceId 已存在时替换旧哈希）
verifier.upsert([
  { evidenceId: 1001, hash: "0123456789abcdef" },
  { evidenceId: 1002, hash: "fedcba9876543210" },
]);

// 批量核验：每个查询返回 { evidenceId, distance } 或 null（未命中）
const results = verifier.verify(["0123456789abcdef", "0000000000000000"]);

// 批量移除（重复移除是 no-op，不影响共享同一哈希的其他编号）
verifier.remove([1001]);
```

命中规则：两个哈希的汉明距离（64 位全部参与，含最高位）不超过 6 才算命中；
每张待查图片只返回一个证据——距离最小者优先，距离相同取编号最小者。

## 实现说明

64 位哈希被切成 4 个 16 位块。仅对低 3 个块建立精确索引，并按半径 2 的
邻域（每块 137 个探针）生成候选：任何总距离不超过 6 的记录，在低 3 个块中
至少有一个块的距离不超过 2，因此候选生成不会漏掉任何真实命中；每个候选再
用 64 位精确 popcount 距离复核。由于存放最高 16 位的块从不参与探测，黑名单
与待查图片共享同一高 16 位的数据分布不会退化。

## 构建与测试

```sh
npm install
npm test
```

测试包含小规模与全量精确计算的一致性对拍（含距离 6/7 边界、最高位差异、
替换/移除后的动态一致性、多编号共享哈希），以及 100 万条记录、1 万次查询
在两类哈希分布下的性能测试（核验耗时与峰值内存断言）。
