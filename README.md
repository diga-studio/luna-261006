# task26100610

家校通知静默时段调度库（纯内存、单线程、逻辑时钟）。

## 用法

```python
from datetime import datetime, time, timezone
from quiet_hours import Scheduler

def on_delivery(event):      # event: DeliveryEvent，返回 True/False 表示投递成败
    print(event.notification_id, event.attempt, event.deliver_at)
    return True

s = Scheduler(datetime(2025, 6, 1, tzinfo=timezone.utc), on_delivery)
s.set_recipient_settings("alice", timezone_name="America/New_York",
                         quiet_start=time(21, 0), quiet_end=time(7, 0))
s.register_notification("n1", "alice", datetime(2025, 6, 2, 1, 0, tzinfo=timezone.utc))
s.advance(datetime(2025, 6, 3, tzinfo=timezone.utc))
print(s.delivery_log())
```

- 普通通知只在收件人当地静默窗口外投递（默认 21:00–07:00，含开始不含结束，可跨午夜）；紧急通知不受限。
- 失败后按 +30s / +120s / +600s 重试，最多 4 次投递；重试下限再按静默规则择时。
- 修改收件人时区或窗口后，未投递尝试立即以 `max(保留的计划下限, 当前时刻)` 重新择时，不重置重试次数。
- `advance(to)` 只向前推进，按事件应发生时刻依次回调；重复推进到同一时刻不会重复投递。

## 测试

```
python3 -m pytest tests/ -q
```
