"""唯一键管理库的自动化测试。"""
import pytest

from uniquekey import ConflictError, RuleError, UniqueKeyManager

OLD_RULE = ("term", "lang", "pos")
NEW_RULE = ("term", "lang")


@pytest.fixture
def manager():
    m = UniqueKeyManager(":memory:", OLD_RULE)
    yield m
    m.close()


def test_save_and_query(manager):
    manager.save_entry("e1", {"term": "run", "lang": "en", "pos": "verb"})
    assert manager.current_rule().fields == OLD_RULE
    entries = {e.entry_id: e.fields for e in manager.list_entries()}
    assert entries == {"e1": {"term": "run", "lang": "en", "pos": "verb"}}


def test_conflict_rejects_whole_save(manager):
    manager.save_entry("e1", {"term": "run", "lang": "en", "pos": "verb"})
    with pytest.raises(ConflictError):
        manager.save_entry("e2", {"term": "run", "lang": "en", "pos": "verb"})
    assert [e.entry_id for e in manager.list_entries()] == ["e1"]


def test_field_boundaries_matter(manager):
    # ("ab","c") 与 ("a","bc") 拼接相同但不是冲突：字段边界有意义
    manager.save_entry("e1", {"term": "ab", "lang": "c", "pos": "x"})
    manager.save_entry("e2", {"term": "a", "lang": "bc", "pos": "x"})
    assert len(manager.list_entries()) == 2


def test_replace_same_id_allowed(manager):
    manager.save_entry("e1", {"term": "run", "lang": "en", "pos": "verb"})
    manager.save_entry("e1", {"term": "run", "lang": "en", "pos": "noun"})
    entries = manager.list_entries()
    assert len(entries) == 1
    assert entries[0].fields["pos"] == "noun"


def test_key_reusable_after_replace_and_delete(manager):
    manager.save_entry("e1", {"term": "run", "lang": "en", "pos": "verb"})
    manager.save_entry("e1", {"term": "walk", "lang": "en", "pos": "verb"})
    manager.save_entry("e2", {"term": "run", "lang": "en", "pos": "verb"})
    manager.delete_entry("e2")
    manager.save_entry("e3", {"term": "run", "lang": "en", "pos": "verb"})
    assert {e.entry_id for e in manager.list_entries()} == {"e1", "e3"}


def test_candidate_only_violation_saves_and_blocks_switch(manager):
    """仅违反候选规则的新增成功且内容保留；冲突存在时切换失败。"""
    manager.save_entry("e1", {"term": "run", "lang": "en", "pos": "verb"})
    # 准备切换到 (term, lang)：e2 只违反候选规则，符合旧规则
    manager.save_entry("e2", {"term": "run", "lang": "en", "pos": "noun"})
    assert {e.entry_id for e in manager.list_entries()} == {"e1", "e2"}
    # 冲突仍存在，切换失败，旧规则保持不变
    assert manager.request_switch(NEW_RULE) is False
    assert manager.current_rule().fields == OLD_RULE
    # 失败的切换不撤销已成功的编辑
    assert {e.entry_id for e in manager.list_entries()} == {"e1", "e2"}


def test_old_rule_violation_still_rejected_during_preparation(manager):
    manager.save_entry("e1", {"term": "run", "lang": "en", "pos": "verb"})
    # 该条目符合候选规则但违反旧规则，仍须拒绝
    with pytest.raises(ConflictError):
        manager.save_entry("e2", {"term": "run", "lang": "en", "pos": "verb"})
    assert [e.entry_id for e in manager.list_entries()] == ["e1"]


def test_switch_success_after_conflict_resolved(manager):
    manager.save_entry("e1", {"term": "run", "lang": "en", "pos": "verb"})
    manager.save_entry("e2", {"term": "run", "lang": "en", "pos": "noun"})
    assert manager.request_switch(NEW_RULE) is False
    # 替换消除冲突后再次请求，结论基于届时内容
    manager.save_entry("e2", {"term": "walk", "lang": "en", "pos": "noun"})
    assert manager.request_switch(NEW_RULE) is True
    assert manager.current_rule().fields == NEW_RULE
    # 成功后对全部现存条目独立计算唯一键无重复
    keys = [tuple(e.fields[f] for f in NEW_RULE) for e in manager.list_entries()]
    assert len(keys) == len(set(keys))


def test_switch_ignores_stale_conflicts(manager):
    """已被删除消除的过时冲突不得导致切换失败。"""
    manager.save_entry("e1", {"term": "run", "lang": "en", "pos": "verb"})
    manager.save_entry("e2", {"term": "run", "lang": "en", "pos": "noun"})
    manager.delete_entry("e2")
    assert manager.request_switch(NEW_RULE) is True
    assert manager.current_rule().fields == NEW_RULE


def test_failed_switch_keeps_deletions(manager):
    manager.save_entry("e1", {"term": "run", "lang": "en", "pos": "verb"})
    manager.save_entry("e2", {"term": "run", "lang": "en", "pos": "noun"})
    manager.save_entry("e3", {"term": "jump", "lang": "en", "pos": "verb"})
    manager.delete_entry("e3")
    assert manager.request_switch(NEW_RULE) is False
    # 失败不恢复已删除的条目
    assert {e.entry_id for e in manager.list_entries()} == {"e1", "e2"}


def test_new_rule_applies_after_switch(manager):
    manager.save_entry("e1", {"term": "run", "lang": "en", "pos": "verb"})
    assert manager.request_switch(NEW_RULE) is True
    # 新规则下 (term, lang) 相同即冲突
    with pytest.raises(ConflictError):
        manager.save_entry("e2", {"term": "run", "lang": "en", "pos": "noun"})
    manager.save_entry("e2", {"term": "run", "lang": "fr", "pos": "verb"})
    assert len(manager.list_entries()) == 2


def test_query_consistency_after_switch(manager):
    """查询不会看到新规则与未满足新规则的内容混在一起。"""
    manager.save_entry("e1", {"term": "run", "lang": "en", "pos": "verb"})
    manager.save_entry("e2", {"term": "run", "lang": "en", "pos": "noun"})
    assert manager.request_switch(NEW_RULE) is False
    rule = manager.current_rule().fields
    keys = [tuple(e.fields[f] for f in rule) for e in manager.list_entries()]
    assert len(keys) == len(set(keys))


def test_persistence_across_reopen(tmp_path):
    db = str(tmp_path / "uk.db")
    m1 = UniqueKeyManager(db, OLD_RULE)
    m1.save_entry("e1", {"term": "run", "lang": "en", "pos": "verb"})
    assert m1.request_switch(NEW_RULE) is True
    m1.close()
    m2 = UniqueKeyManager(db, OLD_RULE)
    assert m2.current_rule().fields == NEW_RULE
    assert [e.entry_id for e in m2.list_entries()] == ["e1"]
    m2.close()


def test_empty_rule_rejected():
    with pytest.raises(RuleError):
        UniqueKeyManager(":memory:", ())
    m = UniqueKeyManager(":memory:", OLD_RULE)
    with pytest.raises(RuleError):
        m.request_switch(())
    m.close()


def test_missing_unique_key_field_rejected(manager):
    with pytest.raises(RuleError):
        manager.save_entry("e1", {"term": "run", "lang": "en"})
