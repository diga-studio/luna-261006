# Brand Pulse — 单品牌滚动负面告警索引

纯 Python 标准库实现，状态只保存在内存中，操作串行调用。情感评分由调用方提供，本库不做任何文本分析。

## 接口

```python
from brand_pulse import NegativeAlertIndex

idx = NegativeAlertIndex(k)              # k: 非负整数阈值，创建后不变
idx.ingest(mention_id, timestamp_ms, score)  # 导入提及，允许乱序；同 ID 重复导入无效
idx.rescore(mention_id, score)               # 替换已存在提及的当前评分
idx.spans(begin_ms, end_ms)                  # 返回 [(start, end), ...] 最大半开告警区间
```

## 语义

- 窗口固定 `WINDOW_MS = 3600000` 毫秒；评分严格小于 `-0.3` 才算负面。
- 对任意整数毫秒 x，`C(x)` 为当前负面提及中满足 `timestamp_ms <= x < timestamp_ms + WINDOW_MS` 的不同 ID 数量；告警成立当且仅当 `C(x) > K`。
- 告警是按最新评分计算的历史区间：重评分会立即重写所有相关历史窗口，可撤销、缩短、拆分或合并已有区间。
- `spans` 返回的区间裁剪到查询范围、互不重叠、相邻已合并；同一毫秒的进入与过期不产生瞬时告警、零长度区间或虚假缝隙。

## 实现说明

- 状态：`dict[mention_id] -> (timestamp_ms, score)`。`ingest` 对已存在 ID 直接忽略（不覆盖重评分后的值，时间戳以首次导入为准）；`rescore` 只改评分。
- `spans` 在查询时基于当前状态做扫描线（sweep-line）计算：每条负面提及贡献 `+1@t` 与 `-1@t+WINDOW_MS` 两个事件；先累计查询起点处已生效的计数，再按事件点推进，计数 `> K` 的连续段即为告警区间，相邻段自动合并。同一事件点的进入与过期合并处理，因此端点语义天然正确。
- 复杂度：`ingest`/`rescore` 为 O(1)，单次 `spans` 为 O(N log N)（N 为当前负面提及数），无持久化、无后台线程。

## 运行测试

```bash
python3 -m unittest test_brand_pulse -v
```
