"""切换与并发编辑交错时的不变量测试。"""
import threading

from uniquekey import UniqueKeyManager

OLD_RULE = ("term", "lang", "pos")
NEW_RULE = ("term", "lang")


def test_switch_racing_with_edits_keeps_invariant(tmp_path):
    """切换与删除/替换并发：无论成败，终态必须自洽。

    - 切换成功 => 全部现存条目在新规则下无重复；
    - 切换失败 => 旧规则仍是生效规则；
    - 并发编辑（删除）不得被撤销。
    """
    db = str(tmp_path / "race.db")
    setup = UniqueKeyManager(db, OLD_RULE)
    setup.save_entry("e1", {"term": "run", "lang": "en", "pos": "verb"})
    setup.save_entry("e2", {"term": "run", "lang": "en", "pos": "noun"})
    setup.close()

    results = {}

    def do_switch():
        m = UniqueKeyManager(db, OLD_RULE)
        try:
            results["switched"] = m.request_switch(NEW_RULE)
        finally:
            m.close()

    def do_delete():
        m = UniqueKeyManager(db, OLD_RULE)
        try:
            m.delete_entry("e2")
        finally:
            m.close()

    t1 = threading.Thread(target=do_switch)
    t2 = threading.Thread(target=do_delete)
    t1.start()
    t2.start()
    t1.join()
    t2.join()

    check = UniqueKeyManager(db, OLD_RULE)
    entries = check.list_entries()
    rule = check.current_rule().fields
    # 删除不被撤销
    assert "e2" not in {e.entry_id for e in entries}
    if results["switched"]:
        assert rule == NEW_RULE
        keys = [tuple(e.fields[f] for f in NEW_RULE) for e in entries]
        assert len(keys) == len(set(keys))
    else:
        assert rule == OLD_RULE
    check.close()
