import random
import unittest

from brand_pulse import BrandPulseIndex, WINDOW_MS

W = WINDOW_MS


def brute_force_spans(index, begin_ms, end_ms):
    """Reference: per-millisecond C(x) > K over the query range.

    C(x) only changes at mention timestamps and expiries, so evaluating the
    left endpoint of each segment between consecutive critical points is
    equivalent to checking every integer millisecond.
    """
    points = {begin_ms, end_ms}
    for ts, _score in index._mentions.values():
        for p in (ts, ts + W):
            if begin_ms < p < end_ms:
                points.add(p)
    ordered = sorted(points)

    def count_at(x):
        return sum(
            1
            for ts, score in index._mentions.values()
            if score < -0.3 and ts <= x < ts + W
        )

    spans = []
    start = None
    for left, right in zip(ordered, ordered[1:]):
        alerting = count_at(left) > index._k
        if alerting and start is None:
            start = left
        elif not alerting and start is not None:
            spans.append((start, left))
            start = None
    if start is not None:
        spans.append((start, end_ms))
    return spans


class IngestTests(unittest.TestCase):
    def test_duplicate_ingest_is_noop(self):
        idx = BrandPulseIndex(0)
        idx.ingest("m1", 100, -0.9)
        idx.ingest("m1", 200, 0.9)  # must not overwrite score or timestamp
        self.assertEqual(idx.spans(0, 100 + W), [(100, 100 + W)])

    def test_duplicate_ingest_does_not_override_rescore(self):
        idx = BrandPulseIndex(0)
        idx.ingest("m1", 100, -0.9)
        idx.rescore("m1", 0.5)
        idx.ingest("m1", 100, -0.9)  # no-op: rescored value stays
        self.assertEqual(idx.spans(0, 100 + W), [])

    def test_out_of_order_ingest(self):
        idx = BrandPulseIndex(0)
        idx.ingest("late", 5000, -0.5)
        idx.ingest("early", 1000, -0.5)
        self.assertEqual(idx.spans(0, 10000), [(1000, 10000)])

    def test_distinct_ids_same_time_and_score_count_separately(self):
        idx = BrandPulseIndex(1)
        idx.ingest("a", 100, -0.5)
        idx.ingest("b", 100, -0.5)
        self.assertEqual(idx.spans(0, 200), [(100, 200)])

    def test_score_exactly_minus_0_3_is_not_negative(self):
        idx = BrandPulseIndex(0)
        idx.ingest("edge", 100, -0.3)
        self.assertEqual(idx.spans(0, 100 + W), [])
        idx.rescore("edge", -0.300001)
        self.assertEqual(idx.spans(0, 100 + W), [(100, 100 + W)])

    def test_rescore_unknown_id_ignored(self):
        idx = BrandPulseIndex(0)
        idx.rescore("ghost", -0.9)
        self.assertEqual(idx.spans(0, 10**9), [])


class ThresholdTests(unittest.TestCase):
    def test_exactly_k_means_no_alert(self):
        idx = BrandPulseIndex(2)
        for i, ts in enumerate((100, 200, 300)):
            idx.ingest(f"m{i}", ts, -0.5)
        # Only 2 concurrent negatives at any instant: never > K=2.
        idx2 = BrandPulseIndex(2)
        for i, ts in enumerate((100, 200)):
            idx2.ingest(f"m{i}", ts, -0.5)
        self.assertEqual(idx2.spans(0, 1000), [])
        # Third mention pushes C to 3 > 2 over [300, 100+W).
        self.assertEqual(idx.spans(0, 300 + W), [(300, 100 + W)])

    def test_k_zero(self):
        idx = BrandPulseIndex(0)
        idx.ingest("a", 50, -0.4)
        self.assertEqual(idx.spans(0, 50 + W), [(50, 50 + W)])

    def test_invalid_k_rejected(self):
        for bad in (-1, 1.5, True):
            with self.assertRaises(ValueError):
                BrandPulseIndex(bad)


class SpanGeometryTests(unittest.TestCase):
    def test_precise_endpoints_and_clipping(self):
        idx = BrandPulseIndex(0)
        idx.ingest("a", 1000, -0.5)
        # Alert is [1000, 1000+W); clipped to the query range.
        self.assertEqual(idx.spans(0, 500), [])
        self.assertEqual(idx.spans(500, 1500), [(1000, 1500)])
        self.assertEqual(idx.spans(1000 + W - 10, 1000 + W + 10), [(1000 + W - 10, 1000 + W)])
        self.assertEqual(idx.spans(1000 + W, 1000 + W + 100), [])

    def test_alert_ends_on_expiry_without_new_mentions(self):
        idx = BrandPulseIndex(0)
        idx.ingest("a", 0, -0.5)
        idx.ingest("b,", 10, 0.9)  # neutral, irrelevant
        self.assertEqual(idx.spans(0, 2 * W), [(0, W)])

    def test_simultaneous_expiry_and_entry_no_gap(self):
        # K=1: two negatives expire exactly when two others enter.
        idx = BrandPulseIndex(1)
        idx.ingest("old1", 0, -0.5)
        idx.ingest("old2", 0, -0.5)
        idx.ingest("new1", W, -0.5)
        idx.ingest("new2", W, -0.5)
        # C(x) = 2 for all x in [0, 2W): one continuous span, no zero-length
        # interval and no false gap at x = W.
        self.assertEqual(idx.spans(0, 2 * W), [(0, 2 * W)])

    def test_expiry_drops_below_threshold_mid_span(self):
        idx = BrandPulseIndex(1)
        idx.ingest("a", 0, -0.5)
        idx.ingest("b", 100, -0.5)
        # C=2 on [100, W), C=1 elsewhere: alert only where C > 1.
        self.assertEqual(idx.spans(0, 2 * W), [(100, W)])

    def test_adjacent_spans_merge(self):
        idx = BrandPulseIndex(0)
        idx.ingest("a", 0, -0.5)
        idx.ingest("b", W, -0.5)  # enters exactly when a expires
        self.assertEqual(idx.spans(0, 3 * W), [(0, 2 * W)])

    def test_empty_and_inverted_range(self):
        idx = BrandPulseIndex(0)
        idx.ingest("a", 0, -0.5)
        self.assertEqual(idx.spans(100, 100), [])
        self.assertEqual(idx.spans(200, 100), [])


class RescoreTests(unittest.TestCase):
    def test_rescore_splits_span_and_restore_merges(self):
        # K=0: three chained negatives create one long alert [0, 2W+1000).
        idx = BrandPulseIndex(0)
        idx.ingest("a", 0, -0.5)
        idx.ingest("b", W, -0.5)
        idx.ingest("c", W + 1000, -0.5)
        self.assertEqual(idx.spans(0, 3 * W), [(0, 2 * W + 1000)])

        # Neutralizing b removes coverage of [W, W+1000): span splits in two.
        idx.rescore("b", 0.0)
        self.assertEqual(idx.spans(0, 3 * W), [(0, W), (W + 1000, 2 * W + 1000)])

        # Restoring b's negative score merges everything back.
        idx.rescore("b", -0.5)
        self.assertEqual(idx.spans(0, 3 * W), [(0, 2 * W + 1000)])

    def test_rescore_shortens_span(self):
        idx = BrandPulseIndex(0)
        idx.ingest("a", 0, -0.5)
        idx.ingest("b", W - 100, -0.5)
        self.assertEqual(idx.spans(0, 3 * W), [(0, 2 * W - 100)])
        idx.rescore("b", 0.1)
        self.assertEqual(idx.spans(0, 3 * W), [(0, W)])

    def test_rescore_can_create_alert_retroactively(self):
        idx = BrandPulseIndex(0)
        idx.ingest("a", 500, 0.8)  # neutral at ingest
        self.assertEqual(idx.spans(0, 1000), [])
        idx.rescore("a", -0.9)  # now alerts in the past
        self.assertEqual(idx.spans(0, 1000), [(500, 1000)])


class PropertyTests(unittest.TestCase):
    def test_matches_brute_force_under_random_interleaved_ops(self):
        rng = random.Random(20261006)
        for trial in range(30):
            k = rng.randint(0, 3)
            idx = BrandPulseIndex(k)
            ids = [f"m{i}" for i in range(8)]
            for _ in range(rng.randint(5, 40)):
                op = rng.choice(("ingest", "rescore", "spans"))
                if op == "ingest":
                    idx.ingest(
                        rng.choice(ids),
                        rng.randint(0, 500),
                        rng.uniform(-1.0, 1.0),
                    )
                elif op == "rescore":
                    idx.rescore(rng.choice(ids), rng.uniform(-1.0, 1.0))
                else:
                    begin = rng.randint(0, 500 + W)
                    end = begin + rng.randint(1, 400)
                    self.assertEqual(
                        idx.spans(begin, end),
                        brute_force_spans(idx, begin, end),
                        f"trial={trial} range=({begin},{end})",
                    )
            # Final full-range check after all mutations.
            self.assertEqual(
                idx.spans(0, 500 + 2 * W),
                brute_force_spans(idx, 0, 500 + 2 * W),
                f"trial={trial} final",
            )


if __name__ == "__main__":
    unittest.main()
