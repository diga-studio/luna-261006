# task26100613

结构化内容唯一键管理库（单内容类型），供上层 CMS 直接调用，内容与生效规则持久化在 SQLite。

## 功能

- 条目 = 稳定 ID + 一组文本字段；唯一键 = 规则选定的若干字段，逐字段完全相等才算冲突。
- `save_entry` 新增或完整替换同 ID 条目；与现存条目在生效规则下冲突时整次保存不生效（`ConflictError`）。
- `delete_entry` 删除后，原唯一键值立即可复用。
- `request_switch` 原子判定切换唯一键规则：候选规则下现存条目无冲突则整体生效，否则失败且旧规则不变；准备期间旧规则持续生效，切换不撤销任何已成功的编辑。
- `current_rule` / `list_entries` 查询始终处于一致状态（规则与内容同事务切换）。

## 用法

```python
from uniquekey import UniqueKeyManager, ConflictError

m = UniqueKeyManager("cms.db", ("term", "lang", "pos"))
m.save_entry("e1", {"term": "run", "lang": "en", "pos": "verb"})

# 准备切换到 (term, lang)：准备期间旧规则继续生效
ok = m.request_switch(("term", "lang"))   # 有冲突则返回 False，可处理后重试
m.close()
```

## 测试

```bash
python3 -m pytest tests/ -q
```
