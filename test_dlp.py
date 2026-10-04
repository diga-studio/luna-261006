"""Unit tests for dlp.Scanner.

Includes an independent, non-streaming reference implementation
(`ref_redact`) written separately from the library; streaming results
under every chunking must match it exactly.
"""

import random
import re
import unittest

from dlp import Scanner

# ---------------------------------------------------------------------
# independent non-streaming reference implementation
# ---------------------------------------------------------------------

_START = re.compile(rb"(?<![0-9A-Za-z])[0-9(]")


def _alnum(b):
    return 0x30 <= b <= 0x39 or 0x41 <= b <= 0x5A or 0x61 <= b <= 0x7A


def _luhn(digits):
    total = 0
    for i, d in enumerate(reversed(digits)):
        if i & 1:
            d *= 2
            if d > 9:
                d -= 9
        total += d
    return total % 10 == 0


def _ref_card(data, i):
    n = len(data)
    pos = []
    j = i
    while j < n and 0x30 <= data[j] <= 0x39 and len(pos) < 19:
        pos.append(j)
        j += 1
        if j < n and 0x30 <= data[j] <= 0x39:
            continue
        if j + 1 < n and data[j] in (0x20, 0x2D) and 0x30 <= data[j + 1] <= 0x39:
            j += 1
            continue
        break
    for k in range(len(pos), 12, -1):
        e = pos[k - 1] + 1
        if k < len(pos):
            if pos[k] == e:  # followed immediately by another digit
                continue
        elif e < n and _alnum(data[e]):
            continue
        if _luhn([data[p] - 0x30 for p in pos[:k]]):
            return (e, pos[:k])
    return None


def _ref_fixed(data, i, pat):
    n = len(data)
    if i + len(pat) > n:
        return None
    for k, p in enumerate(pat):
        b = data[i + k]
        if p == 0x64:
            if not 0x30 <= b <= 0x39:
                return None
        elif b != p:
            return None
    if i + len(pat) < n and _alnum(data[i + len(pat)]):
        return None
    return (i + len(pat), [i + k for k, p in enumerate(pat) if p == 0x64])


def _ref_ssn(data, i):
    if not 0x30 <= data[i] <= 0x39:
        return None
    r = _ref_fixed(data, i, b"ddd-dd-dddd")
    if r is None:
        return None
    e, digs = r
    d = [data[p] - 0x30 for p in digs]
    area = d[0] * 100 + d[1] * 10 + d[2]
    if area == 0 or area == 666 or area >= 900:
        return None
    if d[3] == 0 and d[4] == 0:
        return None
    if d[5] == 0 and d[6] == 0 and d[7] == 0 and d[8] == 0:
        return None
    return (e, digs)


def _ref_phone(data, i):
    if data[i] == 0x28:
        return _ref_fixed(data, i, b"(ddd) ddd-dddd")
    if not 0x30 <= data[i] <= 0x39:
        return None
    return _ref_fixed(data, i, b"ddd-ddd-dddd")


def ref_redact(data):
    """One-shot reference: returns (redacted_bytes, counts)."""
    starts = sorted(m.start() for m in _START.finditer(data))
    out = bytearray(data)
    counts = {"ssn": 0, "card": 0, "phone": 0}
    matchers = {"ssn": _ref_ssn, "card": _ref_card, "phone": _ref_phone}
    for cat in ("ssn", "card", "phone"):
        cur = 0
        for s in starts:
            if s < cur:
                continue
            hit = matchers[cat](data, s)
            if hit is None:
                continue
            e, digs = hit
            for p in digs[:-4]:
                out[p] = 0x58
            counts[cat] += 1
            cur = e
    return bytes(out), counts


# ---------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------

def run_chunks(chunks):
    sc = Scanner()
    out = b""
    for c in chunks:
        out += sc.feed(c)
    tail, counts = sc.finish()
    return out + tail, counts


def run_splits(data, sizes):
    """Feed `data` in chunks of the given sizes; returns (out, counts, max_lag)."""
    sc = Scanner()
    out = b""
    fed = 0
    max_lag = 0
    for sz in sizes:
        c = data[fed:fed + sz]
        fed += len(c)
        out += sc.feed(c)
        max_lag = max(max_lag, fed - len(out))
    tail, counts = sc.finish()
    out += tail
    return out, counts, max_lag


SAMPLE = (
    "员工张三的 SSN 是078-05-1120，工卡4111 1111 1111 1111，"
    "电话 (212) 555-1234 或 212-555-1234。\n"
    "无效：000-12-3456、666-12-3456、900-12-3456、123-00-4567、123-45-0000、"
    "a123-45-6789、123-45-6789b、4111 1111 1111 1112、212-555-12345、"
    "(212)  555-1234、212 555-1234、x(212) 555-1234y。\n"
    "更多无效卡号：1234 5678 9012（12位）、分隔符结尾 4111 1111 1111 1111-。\n"
    "结尾电话 917-555-0110"
).encode("utf-8")


class TestChunkingEquivalence(unittest.TestCase):
    def test_all_two_part_splits(self):
        expected_out, expected_counts = ref_redact(SAMPLE)
        for i in range(len(SAMPLE) + 1):
            out, counts = run_chunks([SAMPLE[:i], SAMPLE[i:]])
            self.assertEqual(out, expected_out, f"split at {i}")
            self.assertEqual(counts, expected_counts, f"split at {i}")

    def test_bytewise(self):
        expected_out, expected_counts = ref_redact(SAMPLE)
        out, counts = run_chunks([SAMPLE[i:i + 1] for i in range(len(SAMPLE))])
        self.assertEqual(out, expected_out)
        self.assertEqual(counts, expected_counts)

    def test_bytewise_with_empty_chunks(self):
        expected_out, expected_counts = ref_redact(SAMPLE)
        chunks = []
        for i in range(len(SAMPLE)):
            chunks.append(b"")
            chunks.append(SAMPLE[i:i + 1])
            if i % 7 == 0:
                chunks.append(b"")
        out, counts = run_chunks(chunks)
        self.assertEqual(out, expected_out)
        self.assertEqual(counts, expected_counts)

    def test_random_chunk_sizes(self):
        expected_out, expected_counts = ref_redact(SAMPLE)
        rng = random.Random(42)
        for _ in range(20):
            sizes = []
            total = 0
            while total < len(SAMPLE):
                sz = rng.randrange(0, 17)
                sizes.append(sz)
                total += sz
            out, counts, _ = run_splits(SAMPLE, sizes)
            self.assertEqual(out, expected_out)
            self.assertEqual(counts, expected_counts)

    def test_reference_sanity(self):
        # the sample must actually contain hits of all three categories
        _, counts = ref_redact(SAMPLE)
        self.assertGreaterEqual(counts["ssn"], 1)
        self.assertGreaterEqual(counts["card"], 1)
        self.assertGreaterEqual(counts["phone"], 3)  # (212)... + 212-... + tail


class TestFallbackAndOverlap(unittest.TestCase):
    def test_card_luhn_fallback_to_shorter(self):
        base = [4, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]
        d13 = next(d for d in range(10) if _luhn(base + [d]))
        d14 = next(d for d in range(10) if not _luhn(base + [d13, d]))
        prefix = "".join(map(str, base + [d13]))
        token = (prefix + " " + str(d14)).encode()
        data = b"card: " + token + b" end"
        out, counts = run_chunks([data])
        # longest (14-digit) candidate fails Luhn; 13-digit prefix hits.
        kept = prefix[-4:].encode()
        expected = b"card: " + b"X" * 9 + kept + b" " + str(d14).encode() + b" end"
        self.assertEqual(out, expected)
        self.assertEqual(counts, {"ssn": 0, "card": 1, "phone": 0})
        # agrees with the reference as well
        self.assertEqual((out, counts), ref_redact(data))

    def test_card_overlapping_ssn(self):
        digits = [1, 2, 3, 4, 5, 6, 7, 8, 9, 0, 1, 2]
        d13 = next(d for d in range(10) if _luhn(digits + [d]))
        token = ("123-45-6789 012" + str(d13)).encode()
        data = b"id " + token + b" ok"
        out, counts = run_chunks([data])
        # SSN masks its first 5 digits, card its first 9; union => 9 X's.
        expected = b"id XXX-XX-XXXX 012" + str(d13).encode() + b" ok"
        self.assertEqual(out, expected)
        self.assertEqual(counts, {"ssn": 1, "card": 1, "phone": 0})
        self.assertEqual((out, counts), ref_redact(data))

    def test_card_overlapping_phone(self):
        digits = [2, 1, 2, 5, 5, 5, 1, 2, 3, 4, 5, 6]
        d13 = next(d for d in range(10) if _luhn(digits + [d]))
        token = ("212-555-1234 56" + str(d13)).encode()
        data = b"tel " + token + b" ok"
        out, counts = run_chunks([data])
        # phone masks digits 1-6, card masks digits 1-9; union => 9 X's,
        # the phone's kept "4" survives only because the card keeps it too.
        expected = b"tel XXX-XXX-XXX4 56" + str(d13).encode() + b" ok"
        self.assertEqual(out, expected)
        self.assertEqual(counts, {"ssn": 0, "card": 1, "phone": 1})
        self.assertEqual((out, counts), ref_redact(data))

    def test_kept_digits_masked_by_other_hit(self):
        # SSN keeps "6789"; a card hit covering them must still mask them.
        digits = [1, 2, 3, 4, 5, 6, 7, 8, 9, 0, 1, 2]
        d13 = next(d for d in range(10) if _luhn(digits + [d]))
        token = ("123-45-6789 012" + str(d13)).encode()
        out, _ = run_chunks([token])
        self.assertNotIn(b"6789", out)


class TestEdges(unittest.TestCase):
    def test_empty_input(self):
        out, counts = run_chunks([])
        self.assertEqual(out, b"")
        self.assertEqual(counts, {"ssn": 0, "card": 0, "phone": 0})

    def test_only_empty_chunks(self):
        out, counts = run_chunks([b"", b"", b""])
        self.assertEqual(out, b"")
        self.assertEqual(counts, {"ssn": 0, "card": 0, "phone": 0})

    def test_candidate_at_stream_end(self):
        out, counts = run_chunks([b"call 917-555-0110"])
        self.assertEqual(out, b"call XXX-XXX-0110")
        self.assertEqual(counts["phone"], 1)

    def test_incomplete_at_stream_end(self):
        out, counts = run_chunks([b"call 917-555-01"])
        self.assertEqual(out, b"call 917-555-01")
        self.assertEqual(counts["phone"], 0)

    def test_feed_after_finish_raises(self):
        sc = Scanner()
        sc.finish()
        with self.assertRaises(ValueError):
            sc.feed(b"x")

    def test_output_length_matches_input(self):
        out, _ = run_chunks([SAMPLE])
        self.assertEqual(len(out), len(SAMPLE))


class TestLongStream(unittest.TestCase):
    def test_long_stream_no_backlog(self):
        hits = b"ssn 078-05-1120 card 4111 1111 1111 1111 tel (212) 555-1234\n"
        segments = [
            b"9" * (12 << 20),                              # long digit run
            b"1234567890123 " * 150000,                     # many candidates
            hits * 20000,                                   # many real hits
            b"8" * (12 << 20),                              # another long run
            b"1-2-3-4-5-6-7-8-9-0-" * 50000,                # digit/sep mix
            b"5" * (4 << 20),
        ]
        data = b" ".join(segments)
        self.assertGreaterEqual(len(data), 32 << 20)

        rng = random.Random(7)
        sizes = []
        total = 0
        while total < len(data):
            sz = rng.randrange(1, 70000)
            sizes.append(sz)
            total += sz

        out, counts, max_lag = run_splits(data, sizes)
        self.assertLessEqual(max_lag, 256)
        self.assertEqual(len(out), len(data))

        expected_out, expected_counts = ref_redact(data)
        self.assertEqual(out, expected_out)
        self.assertEqual(counts, expected_counts)
        self.assertEqual(counts["ssn"], 20000)
        self.assertEqual(counts["phone"], 20000)
        self.assertGreaterEqual(counts["card"], 20000)


if __name__ == "__main__":
    unittest.main()
