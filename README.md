# task26100613

结构化内容唯一键管理库（`uniquekey`），供上层 CMS 直接调用，内容与规则持久化在 SQLite。

## 能力

- 管理单一内容类型：条目 = 稳定 ID + 一组文本字段；唯一键 = 规则选定的若干字段，
  对应字段值逐项完全相同才算冲突（字段边界有意义，不做字符串拼接）。
- `save` 新增或完整替换同 ID 条目；与现存其他条目在生效规则下冲突时整次保存不生效。
  替换/删除成功后，原唯一键值立即可被其他条目使用。
- 规则切换两段式：`prepare_switch` 登记候选规则（旧规则继续生效），
  `apply_switch` 原子判定——以判定时刻的现存条目为准，候选规则下无冲突则整体生效，
  否则失败且旧规则不变；失败不撤销期间任何编辑，可消除冲突后重试。
- 查询接口只返回生效规则与候选规则，不会把新规则与未满足新规则的内容混在一起。

## 用法

```python
from uniquekey import ContentStore, ConflictError

store = ContentStore("cms.db", initial_rule=("term", "lang", "pos"))

store.save("e1", {"term": "猫", "lang": "zh", "pos": "n"})
try:
    store.save("e2", {"term": "猫", "lang": "zh", "pos": "n"})  # 冲突，整体不生效
except ConflictError:
    pass

store.prepare_switch(("term", "lang"))   # 准备期间旧规则仍生效
ok = store.apply_switch()                # 原子判定；False 表示现存内容有冲突
store.close()
```

## 测试

```bash
python3 -m pytest tests/ -q
```
