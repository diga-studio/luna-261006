# 客户旅程修订库

基于 Python + SQLite 的客户旅程修订库，事件与分析结果保存在本地 SQLite 文件中。

## 能力

- `ingest_batch(events)`：批量接收事件。同 ID 重传只计一次；允许任意迟到、乱序，无迟到截止线。每批完成后旅程与榜单同步修订（撤销旧路径贡献、计入新贡献）。
- `journey_of_event(event_id)`：查看指定事件所属的旅程（按规则排序的事件序列）。
- `top_conversion_paths(limit=50)`：查询全局前 50 条转化路径，返回 `(渠道序列, 次数)` 列表。

## 规则

- 每名客户事件按发生时间升序、同时刻按事件 ID 升序；不同客户绝不拼接。
- 相邻事件间隔严格大于 90 天（1 天 = 24 小时）断开，恰好 90 天不断开；转化事件结束当前旅程。
- 转化事件保留在旅程中但不进入路径；只有以转化结束且含非转化事件的旅程贡献榜单，每条合格旅程贡献一次。
- 榜单合并完全相同的路径，按次数降序取前 50；同次数按渠道名 Unicode 码点序逐项比较，前缀相同时短路径在前。

## 使用

```python
from journey_lib import Event, JourneyLibrary

lib = JourneyLibrary("journeys.db")
lib.ingest_batch([
    Event(event_id=1, customer_id="c1", occurred_at=1700000000,
          channel="google", is_conversion=False),
    Event(event_id=2, customer_id="c1", occurred_at=1700000100,
          channel="email", is_conversion=False),
    Event(event_id=3, customer_id="c1", occurred_at=1700000200,
          channel="checkout", is_conversion=True),
])
print(lib.journey_of_event(1))        # 事件 1 所属旅程
print(lib.top_conversion_paths())     # [(['google', 'email'], 1)]
lib.close()
```

## 测试

```bash
python3 -m unittest discover -s tests -v
```

覆盖：迟到触点连接因 90 天间隔断开的旅程、迟到转化拆开已有旅程、重传去重、90 天边界、同时刻排序、客户隔离、榜单合并排序与前 50 截断、到达顺序无关性、重开持久化。
