# terrasync

TerraSync 的可持久化 CSV 增量解析库（纯 Go，无第三方依赖）。

调用方顺序读取只追加的本地文件并把字节推给解析器；库不负责文件发现或调度。
无论字节如何分块、在哪些 `Feed` 之后保存并恢复状态，最终记录、记录顺序、
原始字节区间和错误位置都与一次性解析完全一致。

## 功能

- 四种操作：`Feed`（接收下一段字节，空输入不代表 EOF）、`Finish`（永久结束，
  冲刷末条记录）、`Checkpoint`（任意字节边界导出自包含状态 + 下一输入字节绝对偏移）、
  `Restore`（仅凭状态字节重建解析器）。
- 编码：UTF-8 或 UTF-16LE，严格解码；仅剥离文件开头一个 BOM；配置随检查点恢复。
- CSV 约定：逗号分隔；引号只能在字段开头；引号内 `""` 转义、逗号/CR/LF 均为内容；
  记录结束符为 LF 与 CRLF；引号外孤立 CR 非法；不修剪空白。
- 每条记录返回字段数组与原文件字节半开区间（含记录结束符、不含 BOM）。
- 错误携带原始字节偏移；出错前已完成的记录照常返回；出错记录不输出。
- 内存与检查点大小只随未完成记录增长；解析总工作量随输入字节数线性增长
  （8 MiB 带引号字段逐字节 Feed 约 0.2 s 完成）。

## API 概览

```go
p := terrasync.New(terrasync.UTF8)        // 或 terrasync.UTF16LE
recs, err := p.Feed(chunk)                // 返回本次新完成的记录
state, next, err := p.Checkpoint()        // 持久化 state；下次从 next 偏移续读
q, err := terrasync.Restore(state)        // 原解析器可已销毁
recs, err = q.Feed(more)
tail, err := q.Finish()                   // 永久 EOF：末条记录或错误
```

- `Record{Fields []string, Start, End int64}`：`[Start, End)` 为原文件字节区间。
- `ParseError{Offset int64, Msg string}`：错误位置为原始字节偏移。
- 出错或 `Finish` 之后解析器进入终态，后续调用返回错误；`Checkpoint` 仅在
  未报错的 `Feed` 之后有效。

## 构建与测试

```sh
go build ./...     # 构建
go test ./...      # 运行全部测试
go test -race ./...  # 竞态检测
go test -run Example -v .  # 运行用法示例
```

测试覆盖：两种编码（含 BOM、非 BMP 字符、引号内 CRLF、转义双引号）逐字节切点
保存/恢复并穿插空 Feed；在编码单元、代理对、双引号、CRLF 中间暂停后续传或
`Finish`；合法记录后跟随坏后缀时已完成记录不丢失、错误位置不随分块改变；
8 MiB 带引号字段逐字节 Feed；检查点大小与历史记录无关等。

## 文件结构

- `parser.go` — 类型定义与 CSV 状态机（`Feed`/`Finish`）
- `decode.go` — UTF-8 / UTF-16LE 严格增量解码器与 `ParseError`
- `checkpoint.go` — `Checkpoint`/`Restore`（gob 序列化，自包含）
- `doc.go` — 包文档；`*_test.go` — 自动化测试与用法示例
