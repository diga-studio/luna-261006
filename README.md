# 客户旅程修订库

基于 Python + SQLite 的客户旅程库：事件与分析结果保存在本地 SQLite 文件中，
支持事件任意迟到/乱序/重传，榜单自动撤销旧旅程贡献并计入新贡献。

## 使用

```python
from datetime import datetime
from journey_lib import JourneyLibrary, Event

lib = JourneyLibrary("journeys.sqlite")   # 本地 SQLite 文件，":memory:" 可纯内存

# 1. 批量接收事件（同一 event_id 重传只计一次）
lib.receive_batch([
    Event(1, "customer-a", datetime(2026, 1, 1), "ads", False),
    Event(2, "customer-a", datetime(2026, 1, 2), "email", False),
    Event(3, "customer-a", datetime(2026, 1, 3), "checkout", True),
])

# 2. 查看指定事件当前所属旅程
journey = lib.journey_of_event(2)
print([e.event_id for e in journey.events])   # [1, 2, 3]

# 3. 查询全局前 50 条转化路径：[(渠道序列, 次数), ...]
print(lib.top_paths())                         # [(('ads', 'email'), 1)]

lib.close()
```

## 规则

- 每名客户事件按发生时间升序、同刻按事件 ID 升序排列，不同客户绝不拼接。
- 相邻事件间隔严格大于 90 天（90×24h）断开旅程，恰好 90 天不断开。
- 转化事件结束当前旅程并保留在旅程中，但不进入路径。
- 只有以转化结束且含非转化事件的旅程贡献榜单；路径为非转化事件的渠道序列。
- 榜单合并相同路径，按次数降序取前 50；同次数按渠道名 Unicode 码点序逐项
  比较，前缀相同时短路径在前。
- 每批接收完成后按当前全部事件重算旅程与榜单，结果不依赖到达顺序、
  批次边界或重传次数。

## 测试

```bash
python3 -m pytest tests/ -q
```

覆盖：迟到触点连通被 90 天间隔断开的旅程、迟到转化拆分已有旅程、
90 天边界、同刻按 ID 排序、重传去重、榜单并列排序、前 50 截断、
到达顺序无关性与重开持久化。
