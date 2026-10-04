# task26100606 — 可恢复分片上传库

容器镜像层的可恢复分片上传 Python 库。上传中的字节与完成对象存本地文件，
会话元数据存 SQLite，进程在任意时刻被强杀后重新打开存储目录即可续传。

## 存储布局

```
<root>/
  meta.db                  会话元数据（SQLite, WAL + synchronous=FULL）
  tmp/<session>.part       未完成会话的已确认字节
  objects/sha256-<hex>     已发布对象（按摘要去重，多会话共享）
```

## API

```python
from chunk_upload import UploadStore

with UploadStore("/path/to/storage") as store:
    sid = store.create_session()                 # 创建会话
    info = store.get_session(sid)                # 查询：confirmed_bytes / completed / object_path
    n = store.submit_chunk(sid, offset, stream)  # 提交分片（流式读取），返回已确认字节数
    path = store.complete(sid, sha256_hex)       # 校验全部已确认字节并发布对象
```

- `submit_chunk`：`offset == confirmed` 时整体接收（全有或全无）；`offset` 落在
  已确认前缀内且逐字节相同视为成功重试，不追加；内容冲突、部分重叠越界、
  跳偏移均抛异常且不改变状态。
- `complete`：摘要不符保持原状态可继续上传；完成后会话锁定，相同摘要重复
  完成返回同一对象路径。
- 限制：单分片 256 MiB，单对象 8 GiB；内部流式处理，新增工作内存远低于 32 MiB。

## 崩溃恢复

- 分片：先写文件并 fsync，再提交 SQLite；恢复时把临时文件截断回已确认前缀。
- 发布：硬链接到对象路径（失败时暂存拷贝 + 原子 rename）→ 提交 DB → 删临时文件；
  恢复时清理已完成会话的临时文件与残留暂存文件。
- 恢复过程本身幂等，反复强杀重启无需人工修复。

## 测试

```bash
python3 -m pytest
```

- `tests/test_basic.py`：会话/分片/重试/冲突/错误摘要/去重等语义。
- `tests/test_crash.py`：子进程在分片接收、完成发布、恢复清理各故障点被强杀，
  反复重启验证前缀一致性与最终对象逐字节一致。
- `tests/test_streaming.py`：512 MiB 流式上传，断言 RSS 增长 < 32 MiB。
