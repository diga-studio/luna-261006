"""唯一键管理库的自动化测试。"""

from __future__ import annotations

import threading

import pytest

from uniquekey import (
    ConflictError,
    ContentStore,
    NoCandidateRuleError,
    RuleError,
)

OLD_RULE = ("term", "lang", "pos")
NEW_RULE = ("term", "lang")


def make_fields(term="猫", lang="zh", pos="n"):
    return {"term": term, "lang": lang, "pos": pos}


@pytest.fixture()
def store(tmp_path):
    s = ContentStore(str(tmp_path / "test.db"), OLD_RULE)
    yield s
    s.close()


class TestSaveAndDelete:
    def test_save_and_get(self, store):
        store.save("e1", make_fields())
        assert store.get("e1").fields == make_fields()

    def test_conflict_rejects_whole_save(self, store):
        store.save("e1", make_fields())
        with pytest.raises(ConflictError):
            store.save("e2", make_fields())
        assert store.get("e2") is None

    def test_same_id_replace_not_self_conflict(self, store):
        store.save("e1", make_fields())
        store.save("e1", make_fields())  # 完整替换同 ID 不算冲突
        assert len(store.list_entries()) == 1

    def test_replace_frees_old_key_immediately(self, store):
        store.save("e1", make_fields(term="猫"))
        store.save("e1", make_fields(term="狗"))  # 替换后旧键值释放
        store.save("e2", make_fields(term="猫"))  # 立即可被其他条目使用
        assert store.get("e2").fields["term"] == "猫"

    def test_delete_frees_key_immediately(self, store):
        store.save("e1", make_fields())
        assert store.delete("e1") is True
        assert store.delete("e1") is False
        store.save("e2", make_fields())  # 删除后键值立即可用
        assert store.get("e2") is not None

    def test_field_boundaries_are_meaningful(self, store):
        store.save("e1", make_fields(term="ab", lang="c", pos="x"))
        # 拼接相同但字段边界不同，不算冲突
        store.save("e2", make_fields(term="a", lang="bc", pos="x"))
        assert len(store.list_entries()) == 2

    def test_differing_only_outside_rule_is_conflict(self, store):
        store.save("e1", {**make_fields(), "gloss": "释义一"})
        with pytest.raises(ConflictError):
            # 规则外字段不同，规则内字段全同，仍算冲突
            store.save("e2", {**make_fields(), "gloss": "释义二"})


class TestSwitch:
    def test_apply_without_candidate_raises(self, store):
        with pytest.raises(NoCandidateRuleError):
            store.apply_switch()

    def test_candidate_does_not_affect_active_rule_query(self, store):
        store.prepare_switch(NEW_RULE)
        assert store.get_active_rule() == OLD_RULE
        assert store.get_candidate_rule() == NEW_RULE

    def test_old_rule_still_enforced_during_preparation(self, store):
        store.save("e1", make_fields())
        store.prepare_switch(NEW_RULE)
        # 只符合候选规则、但违反旧规则：仍须拒绝
        with pytest.raises(ConflictError):
            store.save("e2", make_fields())
        assert store.get("e2") is None

    def test_save_violating_only_candidate_succeeds(self, store):
        """场景一：准备期间仅违反候选规则的新增成功且内容保留，
        冲突仍存在时切换失败、旧规则不变。"""
        store.save("e1", make_fields(pos="n"))
        store.prepare_switch(NEW_RULE)
        store.save("e2", make_fields(pos="v"))  # 旧规则下合法，候选规则下冲突
        assert store.get("e2").fields["pos"] == "v"

        assert store.apply_switch() is False
        # 切换失败不撤销已成功的编辑
        assert store.get("e2").fields["pos"] == "v"
        assert store.get_active_rule() == OLD_RULE
        # 查询不会看到新规则与未满足新规则的内容混在一起
        assert store.get_candidate_rule() == NEW_RULE

    def test_retry_after_resolving_conflict(self, store):
        store.save("e1", make_fields(pos="n"))
        store.prepare_switch(NEW_RULE)
        store.save("e2", make_fields(pos="v"))
        assert store.apply_switch() is False
        store.delete("e2")  # 消除冲突后可再次请求切换
        assert store.apply_switch() is True
        assert store.get_active_rule() == NEW_RULE
        assert store.get_candidate_rule() is None

    def test_switch_uses_current_not_stale_content(self, store):
        """场景二：参与切换的条目在准备期间被替换或删除，
        切换判定不采用过时内容。"""
        store.save("e1", make_fields(term="猫", pos="n"))
        store.save("e2", make_fields(term="猫", pos="v"))
        store.prepare_switch(NEW_RULE)
        # 准备期间：e2 被替换，候选规则下的冲突被消除
        store.save("e2", make_fields(term="狗", pos="v"))
        assert store.apply_switch() is True
        assert store.get_active_rule() == NEW_RULE

    def test_switch_detects_conflict_introduced_during_preparation(self, store):
        """不能遗漏准备期间新增的冲突。"""
        store.save("e1", make_fields(term="猫", pos="n"))
        store.prepare_switch(NEW_RULE)
        store.save("e2", make_fields(term="猫", pos="v"))  # 准备期间新增的冲突
        assert store.apply_switch() is False
        assert store.get_active_rule() == OLD_RULE

    def test_failed_switch_does_not_restore_deleted_entries(self, store):
        store.save("e1", make_fields(term="猫", pos="n"))
        store.save("e2", make_fields(term="猫", pos="v"))
        store.prepare_switch(NEW_RULE)
        store.delete("e1")  # 准备期间删除
        assert store.apply_switch() is True  # 已删除条目不参与判定
        assert store.get("e1") is None  # 切换不恢复已删除条目

    def test_keys_unique_after_successful_switch(self, store):
        """成功后对全部现存条目独立计算唯一键应无重复。"""
        store.save("e1", make_fields(term="猫", pos="n"))
        store.save("e2", make_fields(term="猫", pos="v"))
        store.save("e3", make_fields(term="狗", pos="n"))
        store.prepare_switch(NEW_RULE)
        store.delete("e2")
        assert store.apply_switch() is True
        keys = [
            tuple(e.fields[f] for f in store.get_active_rule())
            for e in store.list_entries()
        ]
        assert len(keys) == len(set(keys))

    def test_new_rule_enforced_after_switch(self, store):
        store.save("e1", make_fields(pos="n"))
        store.prepare_switch(NEW_RULE)
        assert store.apply_switch() is True
        with pytest.raises(ConflictError):
            store.save("e2", make_fields(pos="v"))  # 新规则下冲突

    def test_cancel_switch(self, store):
        store.prepare_switch(NEW_RULE)
        store.cancel_switch()
        assert store.get_candidate_rule() is None
        with pytest.raises(NoCandidateRuleError):
            store.apply_switch()


class TestRuleValidation:
    def test_empty_rule_rejected(self, tmp_path):
        with pytest.raises(RuleError):
            ContentStore(str(tmp_path / "t.db"), ())

    def test_duplicate_fields_rejected(self, store):
        with pytest.raises(RuleError):
            store.prepare_switch(("term", "term"))

    def test_missing_rule_field_rejected(self, store):
        with pytest.raises(RuleError):
            store.save("e1", {"term": "猫"})  # 缺 lang/pos


class TestPersistence:
    def test_state_survives_reopen(self, tmp_path):
        db = str(tmp_path / "t.db")
        s = ContentStore(db, OLD_RULE)
        s.save("e1", make_fields())
        s.prepare_switch(NEW_RULE)
        s.close()
        s2 = ContentStore(db, OLD_RULE)
        assert s2.get("e1").fields == make_fields()
        assert s2.get_active_rule() == OLD_RULE
        assert s2.get_candidate_rule() == NEW_RULE
        s2.close()


class TestConcurrency:
    def test_switch_decision_is_atomic_under_concurrent_writes(self, tmp_path):
        """切换判定与并发保存在 SQLite 层面串行化：
        判定只基于原子时刻的现存条目，不采用过时内容。"""
        db = str(tmp_path / "t.db")
        s1 = ContentStore(db, OLD_RULE)
        s1.save("e1", make_fields(term="猫", pos="n"))
        s1.prepare_switch(NEW_RULE)

        s2 = ContentStore(db, OLD_RULE)
        barrier = threading.Barrier(2)
        errors = []

        def writer():
            try:
                barrier.wait()
                for i in range(30):
                    # 候选规则下与 e1 冲突、旧规则下合法的写入
                    s2.save("e2", make_fields(term="猫", pos=f"v{i}"))
                    s2.delete("e2")
            except ConflictError:
                # 切换成功后新规则生效，此类写入被拒绝是正确行为
                pass
            except Exception as exc:  # noqa: BLE001
                errors.append(exc)

        t = threading.Thread(target=writer)
        t.start()
        barrier.wait()
        switched = False
        for _ in range(30):
            try:
                if s1.apply_switch():
                    switched = True
                    break
            except NoCandidateRuleError:
                break
        t.join()
        s2.close()

        assert not errors
        # 无论切换最终成败，状态必须自洽。
        if switched:
            assert s1.get_active_rule() == NEW_RULE
        keys = [
            tuple(e.fields[f] for f in s1.get_active_rule())
            for e in s1.list_entries()
        ]
        assert len(keys) == len(set(keys))
        s1.close()
