"""自动化测试：旅程切分与榜单撤销/计入。"""

import os
import tempfile
import unittest
from datetime import datetime, timedelta

from journey_lib import Event, JourneyLibrary

BASE = datetime(2026, 1, 1, 0, 0, 0)


def ev(event_id, customer, day, channel, conversion=False):
    return Event(event_id, customer, BASE + timedelta(days=day), channel, conversion)


class JourneyLibraryTest(unittest.TestCase):
    def setUp(self):
        fd, self.db_path = tempfile.mkstemp(suffix=".sqlite")
        os.close(fd)
        os.unlink(self.db_path)
        self.lib = JourneyLibrary(self.db_path)

    def tearDown(self):
        self.lib.close()
        if os.path.exists(self.db_path):
            os.unlink(self.db_path)

    def paths(self):
        return dict(self.lib.top_paths())

    def test_late_touchpoint_connects_journeys_split_by_90_day_gap(self):
        """迟到触点补上 90 天间隔缺口后，两段旅程合并，旧路径贡献被撤销。"""
        self.lib.receive_batch([
            ev(1, "c1", 0, "ads"),
            ev(2, "c1", 10, "email"),
            ev(3, "c1", 150, "search"),
            ev(4, "c1", 160, "buy", True),
        ])
        # 10 天 -> 150 天间隔 > 90 天，断开为两段旅程
        self.assertEqual(self.paths(), {("search",): 1})

        # 迟到事件落在第 80 天，把间隔补成 70 天 + 70 天，旅程连通
        self.lib.receive_batch([ev(5, "c1", 80, "social")])
        self.assertEqual(
            self.paths(), {("ads", "email", "social", "search"): 1}
        )
        journey = self.lib.journey_of_event(5)
        self.assertEqual([e.event_id for e in journey.events], [1, 2, 5, 3, 4])

    def test_late_conversion_splits_existing_journey(self):
        """迟到转化把已有旅程拆成两段，两段各自计贡献。"""
        self.lib.receive_batch([
            ev(1, "c1", 0, "ads"),
            ev(2, "c1", 10, "email"),
            ev(3, "c1", 20, "search"),
            ev(4, "c1", 30, "buy", True),
        ])
        self.assertEqual(self.paths(), {("ads", "email", "search"): 1})

        # 迟到转化落在第 15 天，旅程被拆成两段
        self.lib.receive_batch([ev(5, "c1", 15, "buy", True)])
        self.assertEqual(self.paths(), {("ads", "email"): 1, ("search",): 1})
        journey_a = self.lib.journey_of_event(2)
        journey_b = self.lib.journey_of_event(3)
        self.assertEqual([e.event_id for e in journey_a.events], [1, 2, 5])
        self.assertEqual([e.event_id for e in journey_b.events], [3, 4])

    def test_exactly_90_days_does_not_split(self):
        self.lib.receive_batch([
            ev(1, "c1", 0, "ads"),
            ev(2, "c1", 90, "email"),
            ev(3, "c1", 91, "buy", True),
        ])
        self.assertEqual(self.paths(), {("ads", "email"): 1})

    def test_gap_strictly_greater_than_90_days_splits(self):
        self.lib.receive_batch([
            ev(1, "c1", 0, "ads"),
            # 比 90 天多 1 秒
            Event(2, "c1", BASE + timedelta(days=90, seconds=1), "buy", True),
        ])
        self.assertEqual(self.paths(), {})

    def test_conversion_only_journey_does_not_count(self):
        self.lib.receive_batch([ev(1, "c1", 0, "buy", True)])
        self.assertEqual(self.paths(), {})

    def test_unfinished_journey_does_not_count(self):
        self.lib.receive_batch([ev(1, "c1", 0, "ads")])
        self.assertEqual(self.paths(), {})

    def test_duplicate_event_id_counted_once(self):
        batch = [ev(1, "c1", 0, "ads"), ev(2, "c1", 1, "buy", True)]
        self.assertEqual(self.lib.receive_batch(batch), 2)
        self.assertEqual(self.lib.receive_batch(batch), 0)
        self.assertEqual(self.lib.receive_batch([batch[0]]), 0)
        self.assertEqual(self.paths(), {("ads",): 1})

    def test_same_customer_contributes_multiple_times(self):
        self.lib.receive_batch([
            ev(1, "c1", 0, "ads"),
            ev(2, "c1", 1, "buy", True),
            ev(3, "c1", 2, "ads"),
            ev(4, "c1", 3, "buy", True),
        ])
        self.assertEqual(self.paths(), {("ads",): 2})

    def test_different_customers_never_merged(self):
        self.lib.receive_batch([
            ev(1, "c1", 0, "ads"),
            ev(2, "c2", 0, "email"),
            ev(3, "c2", 1, "buy", True),
        ])
        self.assertEqual(self.paths(), {("email",): 1})

    def test_same_timestamp_ordered_by_event_id(self):
        self.lib.receive_batch([
            ev(3, "c1", 0, "c"),
            ev(1, "c1", 0, "a"),
            ev(2, "c1", 0, "b"),
            ev(4, "c1", 1, "buy", True),
        ])
        self.assertEqual(self.paths(), {("a", "b", "c"): 1})

    def test_tie_break_by_unicode_then_shorter_prefix_first(self):
        # 次数相同：按渠道名 Unicode 码点逐项比较；前缀相同短路径在前
        events = []
        eid = 1
        for path in [("b",), ("a", "x"), ("a",)]:
            for i, ch in enumerate(path):
                events.append(ev(eid, f"c-{path}", i, ch))
                eid += 1
            events.append(ev(eid, f"c-{path}", len(path), "buy", True))
            eid += 1
        self.lib.receive_batch(events)
        top = self.lib.top_paths()
        self.assertEqual([p for p, _ in top], [("a",), ("a", "x"), ("b",)])

    def test_top_50_limit(self):
        events = []
        eid = 1
        for i in range(60):
            events.append(ev(eid, f"c{i}", 0, f"ch{i:02d}"))
            events.append(ev(eid + 1, f"c{i}", 1, "buy", True))
            eid += 2
        self.lib.receive_batch(events)
        top = self.lib.top_paths()
        self.assertEqual(len(top), 50)
        self.assertEqual(top[0][0], ("ch00",))

    def test_result_independent_of_arrival_order(self):
        events = [
            ev(1, "c1", 0, "ads"),
            ev(2, "c1", 10, "email"),
            ev(3, "c1", 80, "social"),
            ev(4, "c1", 150, "search"),
            ev(5, "c1", 160, "buy", True),
        ]
        self.lib.receive_batch(events)
        expected = self.paths()

        other = JourneyLibrary(self.db_path + ".2")
        try:
            other.receive_batch(list(reversed(events)))
            self.assertEqual(other.top_paths(), self.lib.top_paths())
            self.assertEqual(dict(other.top_paths()), expected)
        finally:
            other.close()
            os.unlink(self.db_path + ".2")

    def test_journey_of_unknown_event_returns_none(self):
        self.assertIsNone(self.lib.journey_of_event(999))

    def test_persistence_across_reopen(self):
        self.lib.receive_batch([ev(1, "c1", 0, "ads"), ev(2, "c1", 1, "buy", True)])
        self.lib.close()
        self.lib = JourneyLibrary(self.db_path)
        self.assertEqual(self.paths(), {("ads",): 1})


if __name__ == "__main__":
    unittest.main()
