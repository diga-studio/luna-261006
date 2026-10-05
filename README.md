# gradebook-correction

进程内课程成绩纠错组件（TypeScript，零运行时依赖）。key 为 `{course, semester}` 二元组，各 key 状态完全独立。

## 运行

```sh
npm install   # 离线可用：typescript 以 file:vendor/typescript 形式随仓库提供
npm test      # tsc 编译 + node --test
```

## API

- `publishRule(key, rule): Promise<number>` — 首次建立或更正规则，返回递增的 `ruleVersion`；返回时新规则已生效。
- `putGrades(key, studentId, attempts): number` — 同步写入并立即对读取可见，返回该生递增的 `inputVersion`。
- `readGradebook(key): GradebookSnapshot` — 同步返回 `{ruleVersion, rows}`，rows 含 `studentId / inputVersion / total / pass`。
- `computeCount(key): number` — 累计成绩计算次数（测试用来证明无冗余重算）。

## 并发设计

- 每个 key 独立持有 `{rule, ruleVersion, students}`；无跨 key 共享状态。
- 纠错重算分两段：
  1. **异步扫描**：对快照学生逐个按新规则预计算到 pending 表（记录所用 `inputVersion`），每处理一个学生都让出事件循环（默认每 64 个 `setImmediate` 一次；测试注入 `hooks.betweenStudents` 作为确定性暂停点）。此期间 `putGrades` / `readGradebook` 照常同步完成，读取仍看到旧规则下的完整成绩簿。
  2. **同步提交临界区**（无任何 await，单线程下天然原子）：pending 中 `inputVersion` 未变的直接安装；输入已变化或重算期间新增的学生，仅此部分当场按最新输入补算；然后切换 `rule` 与 `ruleVersion`。
- 因此：读取永远等价于某一瞬间的完整成绩簿；写入成功后立即可见；发布成功后旧规则不再可见；切换不漏新学生、不用旧输入的结果覆盖新成绩；未变化的学生绝不重算。
- 单次 `putGrades` 只算该生一行，O(1)，不触碰其他学生。

## 测试（test/）

- `basic.test.ts` — 首次发布、版本递增、跨 key 隔离。
- `partial-recompute.test.ts` — 重算暂停期间覆盖已算学生 + 新增学生；暂停中读写均完成且全用旧规则；恢复后逐行对照新规则与最新输入。
- `stale-pending.test.ts` — 某生 pending 基于旧输入时连续覆盖两次，max→last 策略翻转及格结论，验证旧结果不反向覆盖；另一学期不受影响。
- `scale-recompute.test.ts` — 2 万学生纠错穿插 15 次覆盖，与串行参考全量比对；断言计算次数 = 20000 + 10（仅暂停前已算且被覆盖的学生补算一次），证明未变学生不被反复重算。

暂停点由 `test/helpers/gate.ts` 的 `RecomputeGate` 提供，纯 Promise 交接，无 sleep。
