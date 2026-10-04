# task26100606

`layerstore`：容器镜像层的可恢复分片上传库（纯本地：SQLite + 文件，无服务、无端口）。

## 用法

```python
from layerstore import LayerStore

store = LayerStore("/path/to/storage")   # 打开即自动恢复未完成的会话
sid = store.create_session()             # 1. 创建会话

info = store.get_session(sid)            # 2. 查询：已确认字节数 / 是否完成 / 对象路径
n = store.put_chunk(sid, info.confirmed_bytes, stream)  # 3. 提交分片（顺序字节流）
path = store.complete(sid, sha256_hex)   # 4. 校验 SHA-256 并发布对象
store.close()
```

- 分片偏移等于已确认字节数时整体追加，全部接收或全部不接收。
- 重试范围完全落在已确认前缀内且逐字节相同：返回成功但不追加（范围可与原分片边界不同）。
- 内容冲突、部分覆盖前缀后伸入新区域、跳过末尾的提交：抛异常且会话不变。
- 摘要不符：会话与字节保持不变，可继续上传或重新完成；完成后会话只读，
  相同摘要重复完成返回同一对象。
- 相同内容的会话共享一份 `objects/sha256/<digest>` 对象；进程在任意时刻被
  强杀后，重新打开存储目录即可查询与续传。

限制：单对象 8 GiB，单分片 256 MiB，流式处理新增内存 ≤ 32 MiB（实测约 4 MiB）。
同一存储目录内的调用需顺序执行（不处理并发）。

## 存储布局

```
meta.sqlite3               会话元数据（WAL, synchronous=FULL）
tmp/<session-id>.part      未完成会话的暂存字节
objects/sha256/<hexdigest> 已发布对象（按内容寻址，硬链接发布）
```

## 测试

```
python3 -m pytest tests/ -q
```

覆盖：分片接收/完成发布各阶段强杀后反复重启、跨分片边界重试、内容冲突、
部分重叠、错误摘要、双会话共享对象、已完成会话无临时副本，以及
512 MiB 流式上传的内存上限验证。
