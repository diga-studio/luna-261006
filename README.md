# doc-three-way-merge

需求文档三方合并库（TypeScript）。由上层编辑器调用，文档与合并结果仅驻留内存。
输入为共同底稿、本地稿、修订稿，均由上层拆成行（`string[]`）；行内容逐字符比较，
空白不忽略，空行参与匹配。

## 构建与测试

```sh
npm install
npm test
```

只依赖 Node.js 与 `npm install` 安装的 `typescript`，无其他服务或本机工具要求。

## API

```ts
import { mergeDocuments, resolveMerge } from 'doc-three-way-merge';

const result = mergeDocuments(baseLines, localLines, revisedLines);
// result.segments：按顺序排列的自动合并行与冲突占位
// result.conflicts：冲突列表，含底稿/本地/修订三侧完整片段

const finalLines = resolveMerge(result, ['local', 'revised']);
// 每个冲突分别选择 'local' 或 'revised'，数量与冲突数必须一致
```

- `matchLines(base, next)`：保持顺序的一对一相等行匹配。匹配数最多；
  平局时从第一对起依次比较，底稿行号小者优先，再相同则新版行号小者优先。
- `computeEdits(base, next, matches)`：相邻匹配之间的差异合并为连续替换
  （含纯插入、纯删除；无匹配时整篇为一次替换）。
- 合并规则：未改动行与互不重叠的修改按原顺序保留；两侧完全相同的修改只保留一次；
  替换首尾相接不算重叠；插入点严格位于替换范围内部才算重叠（起点处插入排在替换内容
  之前，终点处之后）；同一位置的不同插入算重叠；重叠关系可传递，连成一组只产生一个
  冲突，冲突片段保留该组覆盖的最小底稿区间及两侧完整内容（含未改动行）。
- 相同输入必得到相同的合并内容、冲突范围及顺序。
