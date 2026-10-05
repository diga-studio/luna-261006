# task26100692
# exam-assembler

职业认证考试的受配额随机组卷库（TypeScript），只负责生成试卷，不包含作答流程。

## API

- `snapshotBank(versions)`：建立题库快照。同一 `questionId` 只保留最大 `version`；
  快照为深拷贝，之后修改原始输入不影响快照。
- `assembleExam(bank, categoryCounts, difficultyCounts, history, seed)`：生成试卷。
  - 两侧配额均为非负整数且总数相同，未列出的类别配额为 0。
  - 试卷精确满足各类别与各难度题数，同一 `questionId` 最多出现一次。
  - 先最小化重复题数量（`questionId` 出现在 `history` 任意试卷中即计一次重复），
    再最小化随机成本总和：`SHA-256(UTF-8(JSON.stringify([seed, questionId])))`
    前 4 字节的大端无符号整数，以 BigInt 精确求和。
  - 仍并列时按排序后的题目 ID 列表字典序取舍；输出按 `questionId` 排序，结果确定。
  - 无解时返回 `{ ok: false, reason }`，绝不返回部分试卷。

## 构建与测试

```sh
npm install
npm test
```
