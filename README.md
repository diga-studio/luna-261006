# doc-three-way-merge

需求文档三方合并库（TypeScript）。输入共同底稿、本地稿、修订稿（均由上层编辑器拆成行），
自动保留能共存的修改，把真正冲突的部分交给作者逐冲突选择。文档与合并结果仅驻留内存。

## 使用

```ts
import { merge, resolve } from './src';

const result = merge(baseLines, localLines, remoteLines);
// result.chunks：按顺序的合并块（已确定的行 / 冲突占位）
// result.conflicts：全部冲突，含底稿片段与两侧各自修改后的完整片段

const finalLines = resolve(result, result.conflicts.map(() => 'local')); // 或逐个选择 'local' / 'remote'
```

- 行内容逐字符比较，空白不忽略，空行参与匹配。
- 匹配规则：保持顺序的一对一相等行匹配，匹配数最多；平局时从第一对起依次优先底稿行号、再新版行号更早者。
- 相同输入必得相同的合并内容、冲突范围及顺序。

## 构建与测试

```sh
npm install
npm test
```

仅依赖 `typescript` 与 `@types/node`（devDependencies），测试使用 Node 内置 test runner。
