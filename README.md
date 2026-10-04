# task26100607

进程内 CI 构建编排库（纯内存状态，无外部服务）。

## 结构

- `ci_orchestrator/types.py` — 阶段名、attempt 状态、`StageRecord` / `BuildSnapshot`。
- `ci_orchestrator/executor.py` — 在 `multiprocessing`（spawn）子进程中执行单个阶段函数；
  子进程异常退出或抛异常都归一为 `error` 结果。
- `ci_orchestrator/orchestrator.py` — 核心。单事件循环线程独占全部状态；
  阶段推进只由循环在“接纳上一条结果”之后触发，后续阶段只能拿到同一 attempt
  已接纳的结果。
- `tests/` — pytest 端到端测试（真实子进程）。

## 安全不变量

- 接纳阶段结果前逐一校验：build 存在、attempt 仍是当前 attempt、attempt 未终结、
  阶段序号恰好等于该 attempt 已接纳记录数。任一不满足即丢弃——被取消/替换的
  attempt 的迟到通知不会改变当前 attempt，也不会启动旧 attempt 的后续阶段。
- 产物只有在同一 attempt 按顺序接纳全部六个 `PASS` 后才会发布；`BLOCK` 立即阻断，
  异常/子进程异常退出使 attempt 失败。
- `rerun` 用原阶段函数创建全新 attempt，旧 attempt 立即被取代并终止其子进程；
  新 attempt 不继承任何旧记录或产物。
- `cancel` 仅对匹配且未终结的当前 attempt 生效，过期标识返回 `False`。

## 运行

```sh
python3 -m pytest tests -q     # 全部自动化测试
PYTHONPATH=. python3 scripts/smoke.py   # 冒烟：一次完整构建
```

测试中用到的两个确定性交错钩子（仅测试使用）：`on_stage_executed` 回调
（子进程已完成某阶段、结果尚未被接纳时触发）与 `hold_stage` / `release_stage`
（暂缓/放行某一 attempt 某阶段结果的接纳）。
