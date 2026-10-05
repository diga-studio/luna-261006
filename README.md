# 课程成绩纠错组件（进程内）

管理员更正评分规则时异步重算已批准成绩，教师录入与成绩簿读取不停。
key 为（课程, 学期）二元组，各 key 独立；数据驻内存。

## 运行

```sh
npm install   # 只需 typescript 一个 devDependency
npm test      # tsc 编译 + node --test 运行全部确定性并发测试
```

## 设计要点（src/gradebook.ts）

- 每个 key 维护：`inputs`（各学生最新输入 + inputVersion）、`view`（当前已发布
  规则下的完整成绩簿）、可选的在途 `job`。
- `putGrades` 同步按当前已发布规则更新该生视图行（O(1)，不触碰其他学生），
  若有纠错在途则把该生加入 job 的 `dirty` 集合。
- `publishRule` 更正规则时创建 job：`dirty` 初始为全部学生，逐批（128 人/批，
  批间让出事件循环）按新规则计算，结果连同所基于的 inputVersion 暂存 `pending`。
  不变式：dirty 之外的学生在 pending 中都有与当前 inputVersion 匹配的结果。
  只有输入变化的学生会被重新放入 dirty 追加计算；dirty 清空后 O(1) 引用交换
  完成切换，临界区内不做任何逐学生计算。
- `readGradebook` 始终读取已发布视图：重算期间仍是旧规则下的完整成绩簿，
  且并发录入即时可见；切换后立即可见新规则。
- 测试通过 `RecomputeHooks`（beforeCompute / afterInputRead / afterCompute）
  提供可控暂停点，配合 Gate/Signal 实现确定性并发，无 sleep。
