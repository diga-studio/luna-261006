# task26100608

NodeShield 实例熔断与请求准入库（Go，纯进程内存，不发送 HTTP 请求）。

## 用法

```go
clk := nodeshield.ClockFunc(func() time.Time { return time.Now() }) // 调用方提供单调时钟
s, _ := nodeshield.New([]string{"inst-a", "inst-b"}, clk)

tk, ok := s.Admit()          // 申请转发：选在途最少者，同数按标识字典序
if ok {
    defer s.Report(tk, nodeshield.ResultSuccess) // 或 ResultFailure（5xx/超时）
}
st, _ := s.Status("inst-a")  // 查看阶段与在途数
```

## 规则摘要

- 每实例最多 32 个在途请求；实例池固定，至多 500 个。
- 正常阶段按完成时刻统计最近 60 秒（恰 60 秒不计），≥20 样本且失败率严格 >50% 触发熔断 30 秒。
- 熔断到期进入试探：最多一个未结束试探，占名额；成功即恢复（空窗口），失败自失败时刻重新熔断 30 秒。
- 试探 5 秒未结束视为超时，自截止时刻重新熔断 30 秒；恰在截止时刻的回报按超时处理。
- 同一凭据只接受第一次有效回报；旧请求/旧试探的迟到回报不影响新阶段、样本与计时。

## 测试

```sh
go test ./...
go test -race ./...
```
