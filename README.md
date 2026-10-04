# task26100610

家校通知静默时段调度库（纯内存、单线程、逻辑时钟）。

## 用法

```python
from datetime import datetime, time, timezone
from quiet_scheduler import Scheduler

sch = Scheduler(
    start=datetime(2025, 1, 1, tzinfo=timezone.utc),
    deliver=lambda d: send(d) is None,   # 同步回调，返回 True/False
)
sch.update_recipient("guardian1", tz_name="America/New_York",
                     quiet_start=time(21, 0), quiet_end=time(7, 0))
sch.register_notification("n1", "guardian1",
                          datetime(2025, 1, 2, 12, 0, tzinfo=timezone.utc),
                          urgent=False)
sch.advance(datetime(2025, 1, 3, tzinfo=timezone.utc))
print(sch.trajectory("n1"))
```

- 普通通知只在收件人当地静默窗口（默认 21:00–07:00，含开始不含结束，可跨午夜）外投递；紧急通知不受限，但遵守同样的失败重试规则（+30s / +120s / +600s，第四次失败永久结束）。
- 修改收件人时区或窗口后，未投递尝试立即按新设置重新择时，不消耗重试次数、不在过去补发。
- 时钟只向前推进；一次推进按时间顺序完成所有到期投递（含连锁重试），大幅推进与多次小幅推进轨迹一致。

## 测试

```bash
python3 -m pytest tests/ -q
```
