"""Brand Pulse: single-brand rolling negative-alert index.

In-memory only. Sentiment scores are supplied by the caller; this module
performs no text analysis.

Semantics: for any integer millisecond x, let C(x) be the number of distinct
mention IDs that are currently negative (score strictly < -0.3) and satisfy
timestamp_ms <= x < timestamp_ms + WINDOW_MS. An alert is active exactly when
C(x) > K. ``spans`` returns the maximal half-open intervals, clipped to the
query range, where the alert is active.
"""

WINDOW_MS = 3600000
NEGATIVE_THRESHOLD = -0.3


class NegativeAlertIndex:
    """Rolling negative-mention alert index for a single brand."""

    def __init__(self, k: int) -> None:
        if not isinstance(k, int) or isinstance(k, bool) or k < 0:
            raise ValueError("k must be a non-negative integer")
        self._k = k
        # mention_id -> (timestamp_ms, current score)
        self._mentions = {}

    def ingest(self, mention_id: str, timestamp_ms: int, score: float) -> None:
        """Import one mention. Re-importing an existing ID is a no-op."""
        if mention_id in self._mentions:
            return
        self._mentions[mention_id] = (timestamp_ms, score)

    def rescore(self, mention_id: str, score: float) -> None:
        """Replace the current score of an existing mention."""
        entry = self._mentions.get(mention_id)
        if entry is None:
            return
        self._mentions[mention_id] = (entry[0], score)

    def spans(self, begin_ms: int, end_ms: int) -> list:
        """Return maximal half-open alert intervals within [begin_ms, end_ms)."""
        if end_ms <= begin_ms:
            return []
        count = 0
        deltas = {}
        for timestamp_ms, score in self._mentions.values():
            if score >= NEGATIVE_THRESHOLD:
                continue
            start = timestamp_ms
            stop = timestamp_ms + WINDOW_MS
            if start <= begin_ms < stop:
                count += 1
            if begin_ms < start < end_ms:
                deltas[start] = deltas.get(start, 0) + 1
            if begin_ms < stop < end_ms:
                deltas[stop] = deltas.get(stop, 0) - 1
        result = []
        prev = begin_ms
        for point in sorted(deltas):
            if count > self._k and prev < point:
                self._append_merged(result, prev, point)
            count += deltas[point]
            prev = point
        if count > self._k and prev < end_ms:
            self._append_merged(result, prev, end_ms)
        return result

    @staticmethod
    def _append_merged(result, start, stop):
        if result and result[-1][1] == start:
            result[-1] = (result[-1][0], stop)
        else:
            result.append((start, stop))
