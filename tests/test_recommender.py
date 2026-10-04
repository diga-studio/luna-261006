"""Recommender 自动化测试。

reference_recommend 是独立的全量参考实现：不依赖库内部结构，
直接从原始数据字典逐步计算，用于与库的输出逐项比对。
"""

import math
import random
import unittest
from decimal import ROUND_HALF_UP, Decimal

from learning_recommender import Recommender


def round8(value):
    return float(Decimal(repr(value)).quantize(Decimal("1e-8"), rounding=ROUND_HALF_UP))


def reference_recommend(weights, published, learner_id):
    """独立全量计算：weights 为 {learner: {content: weight}}（含零权重项）。"""
    target = {c: w for c, w in weights.get(learner_id, {}).items() if w != 0}

    def sim(a, b):
        sa = sum(w * w for w in a.values())
        sb = sum(w * w for w in b.values())
        if sa == 0 or sb == 0:
            return 0.0
        contents = set(a) | set(b)
        dot = sum(a.get(c, 0) * b.get(c, 0) for c in contents)
        return round8(dot / math.sqrt(sa * sb))

    neighbors = []
    for other_id, raw in weights.items():
        if other_id == learner_id:
            continue
        other = {c: w for c, w in raw.items() if w != 0}
        s = sim(target, other)
        if s > 0:
            neighbors.append((other_id, s))
    neighbors.sort(key=lambda item: (-item[1], item[0]))
    neighbors = neighbors[:20]
    if not neighbors:
        return []

    scores = {}
    for other_id, s in neighbors:
        for content_id, w in weights[other_id].items():
            if w <= 0 or content_id not in published or content_id in target:
                continue
            scores[content_id] = scores.get(content_id, 0.0) + w * s

    ranked = sorted(scores.items(), key=lambda item: (-round8(item[1]), item[0]))
    return [c for c, _ in ranked[:10]]


def snapshot(rec):
    """从库实例导出参考实现所需的原始数据（通过公开行为重建）。"""
    return dict(rec._weights), set(rec._published)


class BasicRulesTest(unittest.TestCase):
    def test_weight_overwrite_and_reset(self):
        rec = Recommender()
        rec.set_evidence("u1", "c0", 1)
        rec.set_evidence("u2", "c0", 1)
        rec.set_evidence("u1", "c1", 1)
        rec.set_evidence("u1", "c1", 3)  # 覆盖而非累加
        rec.set_evidence("u2", "c1", 3)
        rec.set_published("c1", True)
        rec.set_published("c2", True)
        rec.set_evidence("u2", "c2", 3)
        self.assertEqual(rec.recommend("u1"), ["c2"])
        rec.set_evidence("u1", "c1", 0)  # 归零后 c1 重新成为未接触
        self.assertEqual(rec.recommend("u1"), ["c1", "c2"])

    def test_invalid_weight_rejected(self):
        rec = Recommender()
        for bad in (2, -1, 4):
            with self.assertRaises(ValueError):
                rec.set_evidence("u1", "c1", bad)

    def test_missing_records_are_zero(self):
        rec = Recommender()
        rec.set_evidence("u1", "c1", 3)
        rec.set_published("c1", True)
        # u2 无任何记录：与 u1 相似度为 0，u1 推荐不到 u2 的内容
        self.assertEqual(rec.recommend("u2"), [])

    def test_unpublished_content_not_recommended(self):
        rec = Recommender()
        rec.set_evidence("u1", "c1", 3)
        rec.set_evidence("u2", "c1", 3)
        rec.set_evidence("u2", "c2", 3)  # c2 从未发布
        self.assertEqual(rec.recommend("u1"), [])

    def test_neighbor_with_zero_weight_on_content_contributes_nothing(self):
        rec = Recommender()
        rec.set_evidence("u1", "c1", 3)
        rec.set_evidence("u2", "c1", 3)
        rec.set_evidence("u2", "c2", 0)  # 显式零权重不算“权重大于0”
        rec.set_published("c2", True)
        self.assertEqual(rec.recommend("u1"), [])

    def test_score_ordering_and_tiebreak(self):
        rec = Recommender()
        rec.set_evidence("u1", "c0", 3)
        rec.set_evidence("u2", "c0", 3)
        rec.set_evidence("u2", "b", 3)
        rec.set_evidence("u2", "a", 3)  # 与 b 同分，按 ID 字典序 a 在前
        for c in ("a", "b"):
            rec.set_published(c, True)
        self.assertEqual(rec.recommend("u1"), ["a", "b"])

    def test_top10_limit(self):
        rec = Recommender()
        rec.set_evidence("u1", "c0", 3)
        rec.set_evidence("u2", "c0", 3)
        for i in range(15):
            cid = f"c{i + 1:02d}"
            rec.set_evidence("u2", cid, 3)
            rec.set_published(cid, True)
        result = rec.recommend("u1")
        self.assertEqual(len(result), 10)
        self.assertEqual(result, sorted(result))  # 同分按字典序


class NeighborBoundaryTest(unittest.TestCase):
    """非共同内容改写使邻居跨越第 20 名边界。"""

    def build(self):
        rec = Recommender()
        rec.set_evidence("target", "shared", 3)
        # 20 名邻居：与 target 的相似度严格递减（各自独有内容不同）
        for i in range(20):
            rec.set_evidence(f"n{i:02d}", "shared", 3)
            rec.set_evidence(f"n{i:02d}", f"private{i:02d}", 3)
        # 第 21 名候选邻居：当前相似度最低
        rec.set_evidence("outsider", "shared", 3)
        rec.set_evidence("outsider", "extra", 3)
        rec.set_evidence("outsider", "extra2", 3)
        # outsider 独有内容，只有它入选时才会被推荐
        rec.set_evidence("outsider", "only-outsider", 3)
        rec.set_published("only-outsider", True)
        return rec

    def test_outsider_initially_excluded(self):
        rec = self.build()
        self.assertNotIn("only-outsider", rec.recommend("target"))

    def test_rewrite_on_nonshared_content_crosses_boundary(self):
        rec = self.build()
        # 把排名第 20 的邻居 n19 在 target 从未接触的内容上权重加大，
        # 其相似度下降，outsider 越过边界进入前 20
        rec.set_evidence("n19", "private19", 3)
        rec.set_evidence("n19", "pad1", 3)
        rec.set_evidence("n19", "pad2", 3)
        rec.set_evidence("n19", "pad3", 3)
        self.assertIn("only-outsider", rec.recommend("target"))
        # 再改写回非共同内容，outsider 又被挤出
        rec.set_evidence("n19", "pad1", 0)
        rec.set_evidence("n19", "pad2", 0)
        rec.set_evidence("n19", "pad3", 0)
        self.assertNotIn("only-outsider", rec.recommend("target"))


class PublishStateTest(unittest.TestCase):
    """内容下线再上线，邻居不变而候选资格正确变化。"""

    def test_unpublish_and_republish(self):
        rec = Recommender()
        rec.set_evidence("u1", "c1", 3)
        rec.set_evidence("u2", "c1", 3)
        rec.set_evidence("u2", "c2", 3)
        rec.set_published("c2", True)
        self.assertEqual(rec.recommend("u1"), ["c2"])

        rec.set_published("c2", False)  # 下线：候选资格消失，证据保留
        self.assertEqual(rec.recommend("u1"), [])

        rec.set_published("c2", True)  # 重新上线：立即恢复
        self.assertEqual(rec.recommend("u1"), ["c2"])

    def test_unpublish_does_not_change_neighbors(self):
        rec = Recommender()
        rec.set_evidence("u1", "c1", 3)
        rec.set_evidence("u2", "c1", 3)
        rec.set_evidence("u2", "c2", 3)
        rec.set_evidence("u3", "c1", 3)
        rec.set_evidence("u3", "c3", 3)
        rec.set_published("c2", True)
        rec.set_published("c3", True)
        before = rec.recommend("u1")
        self.assertEqual(before, ["c2", "c3"])
        # 下线 c2 不影响 u2 仍是邻居：c3 仍在，c2 消失
        rec.set_published("c2", False)
        self.assertEqual(rec.recommend("u1"), ["c3"])


class ConsistencyTest(unittest.TestCase):
    """随机小规模操作序列下，库结果与独立全量计算逐项一致。"""

    def test_random_ops_match_reference(self):
        rng = random.Random(20261006)
        learners = [f"u{i}" for i in range(8)]
        contents = [f"c{i}" for i in range(12)]
        rec = Recommender()
        weights = {}
        published = set()
        for step in range(400):
            op = rng.randrange(3)
            if op == 0:
                u = rng.choice(learners)
                c = rng.choice(contents)
                w = rng.choice([0, 1, 3])
                rec.set_evidence(u, c, w)
                weights.setdefault(u, {})[c] = w
            elif op == 1:
                c = rng.choice(contents)
                p = rng.random() < 0.6
                rec.set_published(c, p)
                (published.add if p else published.discard)(c)
            else:
                u = rng.choice(learners)
                got = rec.recommend(u)
                want = reference_recommend(weights, published, u)
                self.assertEqual(got, want, f"step {step}, learner {u}")

    def test_snapshot_consistency_after_each_mutation(self):
        rng = random.Random(7)
        learners = [f"u{i}" for i in range(25)]
        contents = [f"c{i}" for i in range(30)]
        rec = Recommender()
        for _ in range(300):
            u = rng.choice(learners)
            c = rng.choice(contents)
            rec.set_evidence(u, c, rng.choice([0, 1, 3]))
            rec.set_published(rng.choice(contents), rng.random() < 0.5)
            weights, published = snapshot(rec)
            for probe in rng.sample(learners, 3):
                self.assertEqual(
                    rec.recommend(probe),
                    reference_recommend(weights, published, probe),
                )


if __name__ == "__main__":
    unittest.main()
