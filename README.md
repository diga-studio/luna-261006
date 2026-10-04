# task26100607

进程内 CI 构建编排库（纯内存状态，无外部服务）。

## 结构

- `ci_orchestrator/types.py` — 阶段名、状态枚举、快照等类型定义。
- `ci_orchestrator/executor.py` — 在 `multiprocessing`（spawn）子进程中运行单个阶段函数。
- `ci_orchestrator/orchestrator.py` — `Orchestrator`：`submit` / `rerun` / `cancel` / `get`。
- `tests/` — 自动化测试（含取消/重跑与阶段完成交错的竞态场景）。

## 行为要点

- 每次构建固定顺序执行六个阶段：checkout、resolve_deps、security_scan、
  license_check、build、store。任一阶段返回 `BLOCK` 立即阻断；阶段抛异常或
  子进程异常退出则该 attempt 失败。
- 后续阶段只收到同一 attempt 内已通过阶段的结果；store 阶段返回的字节即最终产物。
- `rerun` 用原阶段函数创建新 attempt 并取代当前 attempt；`cancel` 仅对匹配且
  未终结的当前 attempt 生效。被取消/取代的 attempt，其迟到的结果通知在
  接纳点（持锁检查 token 与状态）被丢弃，不会推进后续阶段，也不会污染新
  attempt 的门禁记录或产物。

## 运行测试

```sh
python3 -m pytest tests/ -v
```

## 使用示例

```python
from ci_orchestrator import Orchestrator

orch = Orchestrator()
attempt = orch.submit("build-1", [checkout_fn, deps_fn, scan_fn, license_fn, build_fn, store_fn])
snap = orch.get("build-1")   # 自洽快照：当前 attempt、状态、阶段记录、产物
```
