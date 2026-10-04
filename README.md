# Brand Pulse — 单品牌滚动负面告警索引

纯 Python 标准库实现，状态只在内存中，操作串行调用。情感评分由调用方提供，本库不做任何文本分析。

## 接口

```python
from brand_pulse import BrandPulseIndex

idx = BrandPulseIndex(k=1)                 # 阈值 K：非负整数，创建后不变
idx.ingest("mention-1", 1_700_000_000_000, -0.82)  # 导入提及，允许乱序；同 ID 重复导入无效
idx.rescore("mention-1", 0.2)              # 重评分，立即影响所有历史窗口
spans = idx.spans(begin_ms, end_ms)        # 查询告警区间
```

- 窗口固定 `WINDOW_MS = 3600000` 毫秒；评分严格小于 `-0.3` 才算负面。
- `spans(begin_ms, end_ms)` 返回告警成立的所有**最大半开区间** `[(start, end), ...]`，
  已裁剪到查询范围、互不重叠、相邻区间已合并。
- 告警是按最新评分计算的历史区间：`rescore` 可以撤销、缩短、拆分或合并已有区间。

## 性质

任意操作完成后，对任意整数毫秒 `x`，令 `C(x)` 为当前负面提及中满足
`timestamp_ms <= x < timestamp_ms + 3600000` 的不同 ID 数量，则 `spans` 返回区间的并集
恰好覆盖查询范围内 `C(x) > K` 的时刻。同一毫秒的进入与过期相互抵消，不会产生
瞬时告警、零长度区间或虚假缝隙；没有新提及的时刻也会因过期而结束告警。

## 实现说明

- 存储：`dict[mention_id] -> (timestamp_ms, score)`。时间戳首次导入后不再改变；
  重复 `ingest` 直接忽略，不会覆盖 `rescore` 后的评分。
- `spans` 使用扫描线：先统计查询起点 `begin_ms` 处已在窗口内的负面提及数作为初始计数，
  再把 `(begin_ms, end_ms)` 内的每次进入（`timestamp_ms` 处 +1）与过期
  （`timestamp_ms + WINDOW_MS` 处 -1）按时间排序合并处理——同一毫秒的所有增量先求和再
  判定阈值，因此同毫秒的进入/过期天然抵消。计数在 `K` 上下穿越时开合区间，
  末尾未闭合的区间裁剪到 `end_ms`。
- 复杂度：`ingest` / `rescore` 为 O(1)；`spans` 为 O(N log N)，N 为当前提及数。
  因为告警按查询时的最新评分现算，无需在 `rescore` 时维护任何增量结构。

## 运行测试

```bash
python3 -m unittest test_brand_pulse -v
```

覆盖：同毫秒多条提及、计数恰好等于 K、评分恰好为 -0.3、一批过期与另一批进入同时发生、
精确端点与裁剪、相邻区间合并、重评分使区间拆分/缩短/追溯生成、恢复评分后重新合并，
以及随机交错操作下与逐毫秒参考实现（坐标压缩版暴力法）的对拍。
