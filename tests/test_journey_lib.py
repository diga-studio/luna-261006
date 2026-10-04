"""journey_lib 自动化测试。"""
import os
import random
import tempfile
import unittest

from journey_lib import Event, JourneyLibrary
from journey_lib.core import MAX_GAP_SECONDS


def ev(event_id, customer, t, channel, conv=False):
    return Event(event_id, customer, float(t), channel, conv)


class JourneyLibTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.lib = JourneyLibrary(os.path.join(self.dir, "test.db"))

    def tearDown(self):
        self.lib.close()

    def journey_ids(self, event_id):
        journey = self.lib.journey_of_event(event_id)
        return None if journey is None else [e.event_id for e in journey]

    def test_late_touchpoint_connects_gap(self):
        """迟到触点连接原本因 >90 天间隔断开的旅程。"""
        day = 24 * 3600
        # 两个触点间隔 100 天，各自成旅程；只有第一条转化合格。
        self.lib.ingest_batch([
            ev(1, "c1", 0, "google"),
            ev(2, "c1", 10 * day, "conv", True),
            ev(3, "c1", 110 * day, "wechat"),
            ev(4, "c1", 115 * day, "conv", True),
        ])
        self.assertEqual(self.journey_ids(1), [1, 2])
        self.assertEqual(self.journey_ids(3), [3, 4])
        self.assertEqual(self.lib.top_conversion_paths(),
                         [(["google"], 1), (["wechat"], 1)])

        # 迟到触点落在中间（第 60 天），把两段连成一条旅程。
        self.lib.ingest_batch([ev(5, "c1", 60 * day, "email")])
        self.assertEqual(self.journey_ids(1), [1, 2])
        self.assertEqual(self.journey_ids(3), [5, 3, 4])
        # 旧路径 wechat 被撤销，新路径 email,wechat 计入。
        self.assertEqual(self.lib.top_conversion_paths(),
                         [(["email", "wechat"], 1), (["google"], 1)])

    def test_late_conversion_splits_journey(self):
        """迟到转化把已有旅程拆成两条。"""
        day = 24 * 3600
        self.lib.ingest_batch([
            ev(1, "c1", 0, "google"),
            ev(2, "c1", 5 * day, "email"),
            ev(3, "c1", 10 * day, "conv", True),
        ])
        self.assertEqual(self.journey_ids(1), [1, 2, 3])
        self.assertEqual(self.lib.top_conversion_paths(),
                         [(["google", "email"], 1)])

        # 迟到转化插在第 2 天，旅程被拆成两段。
        self.lib.ingest_batch([ev(4, "c1", 2 * day, "conv", True)])
        self.assertEqual(self.journey_ids(1), [1, 4])
        self.assertEqual(self.journey_ids(2), [2, 3])
        # 旧路径 google,email 撤销；新路径 google 与 email 各计一次。
        self.assertEqual(self.lib.top_conversion_paths(),
                         [(["email"], 1), (["google"], 1)])

    def test_duplicate_retransmit_counts_once(self):
        self.lib.ingest_batch([ev(1, "c1", 0, "google"),
                               ev(2, "c1", 10, "conv", True)])
        self.lib.ingest_batch([ev(1, "c1", 0, "google"),
                               ev(2, "c1", 10, "conv", True)])
        self.lib.ingest_batch([ev(1, "c1", 0, "google")])
        self.assertEqual(self.lib.top_conversion_paths(), [(["google"], 1)])

    def test_gap_boundary_exactly_90_days(self):
        self.lib.ingest_batch([
            ev(1, "c1", 0, "a"),
            ev(2, "c1", MAX_GAP_SECONDS, "b"),
            ev(3, "c1", 2 * MAX_GAP_SECONDS + 1, "c"),
            ev(4, "c1", 2 * MAX_GAP_SECONDS + 2, "conv", True),
        ])
        self.assertEqual(self.journey_ids(1), [1, 2])
        self.assertEqual(self.journey_ids(3), [3, 4])
        self.assertEqual(self.lib.top_conversion_paths(), [(["c"], 1)])

    def test_same_timestamp_ordered_by_event_id(self):
        self.lib.ingest_batch([
            ev(3, "c1", 100, "c"),
            ev(1, "c1", 100, "a"),
            ev(2, "c1", 100, "b"),
            ev(4, "c1", 100, "conv", True),
        ])
        self.assertEqual(self.journey_ids(1), [1, 2, 3, 4])
        self.assertEqual(self.lib.top_conversion_paths(),
                         [(["a", "b", "c"], 1)])

    def test_customers_never_mixed(self):
        self.lib.ingest_batch([
            ev(1, "c1", 0, "a"),
            ev(2, "c2", 1, "x"),
            ev(3, "c1", 2, "conv", True),
            ev(4, "c2", 3, "conv", True),
        ])
        self.assertEqual(self.journey_ids(1), [1, 3])
        self.assertEqual(self.journey_ids(2), [2, 4])
        self.assertEqual(self.lib.top_conversion_paths(),
                         [(["a"], 1), (["x"], 1)])

    def test_unqualified_journeys_excluded(self):
        self.lib.ingest_batch([
            ev(1, "c1", 0, "a"),            # 无转化，不合格
            ev(2, "c2", 0, "conv", True),  # 纯转化，不合格
        ])
        self.assertEqual(self.lib.top_conversion_paths(), [])

    def test_leaderboard_merges_and_sorts(self):
        events = []
        eid = 0
        # 路径 ("b",) 3 次、("a", "b") 3 次、("a",) 2 次、("z",) 1 次
        for path, times in [(("b",), 3), (("a", "b"), 3),
                            (("a",), 2), (("z",), 1)]:
            for i in range(times):
                customer = f"c{eid}"
                t = 0
                for ch in path:
                    eid += 1
                    events.append(ev(eid, customer, t, ch))
                    t += 1
                eid += 1
                events.append(ev(eid, customer, t, "conv", True))
        random.Random(42).shuffle(events)
        # 分多批乱序入库
        for i in range(0, len(events), 5):
            self.lib.ingest_batch(events[i:i + 5])
        self.assertEqual(self.lib.top_conversion_paths(), [
            (["a", "b"], 3),
            (["b"], 3),
            (["a"], 2),
            (["z"], 1),
        ])

    def test_leaderboard_limit_50(self):
        events = []
        eid = 0
        for i in range(60):
            eid += 1
            events.append(ev(eid, f"c{i}", 0, f"ch{i:02d}"))
            eid += 1
            events.append(ev(eid, f"c{i}", 1, "conv", True))
        self.lib.ingest_batch(events)
        top = self.lib.top_conversion_paths()
        self.assertEqual(len(top), 50)
        self.assertEqual(top[0], (["ch00"], 1))
        self.assertEqual(top[-1], (["ch49"], 1))

    def test_result_independent_of_arrival_order(self):
        base = [
            ev(1, "c1", 0, "google"),
            ev(2, "c1", 100, "email"),
            ev(3, "c1", 200, "conv", True),
            ev(4, "c1", 300, "wechat"),
            ev(5, "c1", 400, "conv", True),
            ev(6, "c2", 0, "google"),
            ev(7, "c2", 50, "conv", True),
        ]
        expected = [(["google"], 1), (["google", "email"], 1), (["wechat"], 1)]
        for seed in range(5):
            shuffled = base[:]
            random.Random(seed).shuffle(shuffled)
            lib = JourneyLibrary(os.path.join(self.dir, f"order{seed}.db"))
            for event in shuffled:  # 逐条乱序入库
                lib.ingest_batch([event])
            self.assertEqual(lib.top_conversion_paths(), expected)
            self.assertEqual([e.event_id for e in lib.journey_of_event(1)],
                             [1, 2, 3])
            lib.close()

    def test_persistence_across_reopen(self):
        db = os.path.join(self.dir, "persist.db")
        lib = JourneyLibrary(db)
        lib.ingest_batch([ev(1, "c1", 0, "a"), ev(2, "c1", 1, "conv", True)])
        lib.close()
        lib = JourneyLibrary(db)
        self.assertEqual(lib.top_conversion_paths(), [(["a"], 1)])
        self.assertEqual([e.event_id for e in lib.journey_of_event(1)], [1, 2])
        lib.close()


if __name__ == "__main__":
    unittest.main()
