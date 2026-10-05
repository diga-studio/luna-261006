# HireCircle Local

静态候选人搜索库（TypeScript）。公开两个操作：`buildIndex` 与 `search`。

## 构建与测试

```sh
npm install
npm test        # 编译 src/ 与 test/ 并运行 node:test 测试
npm run build   # 仅编译到 dist/
```

## API

```ts
import { buildIndex, search } from 'hirecircle-local';

const index = buildIndex(candidates); // 不接收查询；同一索引服务任意查询
const { hits, scoredVersions } = search(index, query, {
  onScoreVersion: (obs) => { /* 每份被评分简历回调一次，用于独立核对 */ },
});
```

- 候选人：ID、标签集合、1–3 版简历；每版含版本 ID、技能集合、整数经验月数。
- 查询：AND/OR/NOT 过滤树（叶子为标签或技能的精确包含）、最多 12 个评分叶子
  （权重 1–100）以及目标经验月数。
- 版本分数 = 命中评分项权重之和 + 经验接近度 `max(0, 60 - |实际月数 - 目标月数|)`；
  只有通过完整过滤的版本参与排名，过滤/评分/解释基于同一版本。
- 候选人分数 = 合格版本最高分；并列时取版本 ID 字典序最小者为见证。
- `hits`：精确前 k 名，按分数降序、候选人 ID 字典序升序，含分数、见证版本 ID
  及该版本命中的评分项。
- `scoredVersions`：本次调用中发生查询相关评分工作的不同简历数。

## 实现要点

- 索引：技能/标签倒排表 + 按经验排序的版本数组，不含任何查询相关信息。
- 过滤：按查询词项即时构建位图，过滤树用位图集合运算求值（集合级操作）。
- 排名：先用最紧的评分项交集做种子抬高阈值，再用 WAND（带一个覆盖全库的
  虚拟零权重经验词项保证精确性）做 top-k，只在枢轴简历上计算分数。
