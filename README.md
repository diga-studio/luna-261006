# terrasync

TerraSync 可持久化 CSV 增量解析库（Go）。调用方顺序读取只追加的本地文件，
把字节块交给解析器；库不负责文件发现或调度，可在任意位置导出/恢复解析状态。

## 特性

- `Feed([]byte)`：接收下一段字节，立即返回新完成的记录；空输入不表示文件结束。
- `Finish()`：表示文件永久结束，返回末条未换行记录或对未闭合引号、不完整
  编码单元、未配对代理项报错。
- `Checkpoint()`：在任意未报错的 `Feed` 之后导出自包含状态字节和下一输入字节
  的绝对偏移；不要求位于记录边界。
- `Restore(state)`：从状态字节重建解析器，调用方从返回偏移继续喂数据即可，
  无需重读文件前缀。

解析约定：逗号分隔；UTF-8 或 UTF-16LE 严格解码，仅剥离文件开头一个 BOM；
引号只能出现在字段开头，`""` 表示转义引号；记录结束符为 LF 或 CRLF，
引号外孤立 CR 非法；每条记录返回字段数组和原文件字节半开区间
（含记录结束符、不含 BOM）。错误使用原始字节偏移，错误前已完成的记录照常返回。

## 运行测试

```sh
go test ./...          # 全部测试
go test -race ./...    # 竞态检测
go test -run TestHuge -v ./...   # 8 MiB 逐字节 Feed 线性性能验证
```

## 使用示例

```go
p := terrasync.New(terrasync.UTF8)
recs, err := p.Feed(chunk)          // chunk 为任意分块
// ...
state, nextOff, err := p.Checkpoint() // 持久化 state，记录 nextOff

q, off, err := terrasync.Restore(state) // 之后（甚至另一进程）恢复
recs, err = q.Feed(more)                // more 从 off 处开始
last, err := q.Finish()
```

## 文件

- `parser.go` — 增量状态机、严格 UTF-8/UTF-16LE 解码、Feed/Finish。
- `checkpoint.go` — gob 编码的自包含状态导出与恢复。
- `parser_test.go` — 基础语法、BOM、UTF-16、错误位置测试。
- `checkpoint_test.go` — 两种编码下遍历每个字节切点的保存/恢复测试。
- `boundary_test.go` — 编码单元/代理对/引号/CRLF 中间暂停、坏后缀错误位置稳定性。
- `stress_test.go` — 8 MiB 带引号字段逐字节 Feed，暴露重复扫描或累计复制。
