# listing-dedup-index

房源重复候选检索库（TypeScript）。由上层清洗流水线直接调用，房源目录与检索状态只保存在进程内存；本模块只返回重复候选，不执行合并。

## 构建与测试

```bash
npm install
npm test        # 编译 + 运行全部自动化测试
npm run perf    # 运行两类 10 万条规模的性能样例
```

只依赖 Node.js 与 `npm install` 安装的开发依赖（typescript、@types/node），不需要任何外部服务。

## API

```ts
import { ListingDedupIndex, type ListingInput, type DuplicateCandidate } from "./src/index.js";

const index = new ListingDedupIndex(listings); // listings: Iterable<ListingInput>，装入后不再修改
const candidates: DuplicateCandidate[] = index.findDuplicates(query, 0.8, 0.85);
```

- `ListingInput`：`{ id, address, description }`。文本应已完成 Unicode NFC 规范化；本模块不再改变大小写、标点或空白。
- `findDuplicates(query, addressThreshold, descriptionThreshold)`：返回目录中**地址与描述相似度均达到各自阈值**的全部记录（含恰好相等），按目录装入顺序返回。查询房源不属于目录，查询不改动目录。
- 阈值范围 `[0.70, 1.00]`、最多两位小数，否则抛 `RangeError`。
- 相似度 = `1 - Levenshtein编辑距离 / max(两侧码点长度)`；长度与编辑单位均为 Unicode 码点（非 BMP 字符算 1 个），插/删/替代价为 1，相邻交换不算一次编辑。两侧均空串相似度为 1，仅一侧为空为 0。
- 阈值判定使用整数运算（`ed*100 <= (100-t*100)*maxLen`），不做四舍五入。
- 目录中不同 `id` 即使文本完全相同也会分别作为候选返回。

## 实现要点

- **编辑距离**：完整 DP（参考实现）+ Myers 位并行精确算法（查询验证路径，pattern 每查询只预处理一次）。
- **候选预筛**：每个字段一个 q-gram 倒排索引（地址 q=2、描述 q=3，FNV 哈希分桶，扁平数组存储）。查询时按 posting 代价估计选择字段，用「编辑距离 ≤ k ⇒ 共有 q-gram 数 ≥ maxLen-q+1-kq」做计数过滤（只误报、不漏报），候选再经逐条 q-gram 复核与精确编辑距离验证。
- 查询文本过短（不足 q 个码点）时退化为全量扫描 + 精确验证，保证正确性。
- 单进程串行调用；不提供持久化、并发更新与崩溃恢复。

## 性能样例（本机实测，10 万条目录，阈值 0.80/0.80，1000 条查询）

| 样例 | 装入耗时 | 查询累计耗时 | 峰值内存 | 命中 |
| --- | --- | --- | --- | --- |
| A：地址高度重复、描述有区分度 | ~1.0 s | ~10 s（要求 ≤ 30 s） | ~430 MiB（要求 ≤ 512 MiB） | 平均 6、最大 6 条 |
| B：描述复用模板、地址有区分度 | ~1.0 s | ~3 s（要求 ≤ 30 s） | ~435 MiB（要求 ≤ 512 MiB） | 平均 6、最大 7 条 |

两个样例地址中位长度 ≥ 40 码点、描述中位长度 ≥ 160 码点；每个样例在独立进程中运行，并对 25 条抽样查询做不经过索引的逐对精确核对，命中集合完全一致。

## 目录结构

- `src/levenshtein.ts`：码点转换、完整/带状 DP、Myers 位并行距离、相似度。
- `src/catalog.ts`：目录存储、q-gram 倒排索引、阈值校验、`ListingDedupIndex`。
- `test/`：单元测试与随机小目录对独立逐对精确计算的一致性测试。
- `perf/benchmark.ts`：两类性能样例，报告装入耗时、查询累计耗时、峰值内存并独立核对命中。
