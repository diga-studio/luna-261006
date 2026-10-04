"""IGES 结构预检测试。"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from builders import build_file, chunk, make_d_pair, make_line, make_p_line  # noqa: E402

from iges_precheck import precheck_bytes, precheck_file  # noqa: E402


def error_codes(data: bytes):
    return [e.code for e in precheck_bytes(data).errors]


def patch_line(data: bytes, lineno: int, new_line: bytes,
               newline: bytes = b"\n") -> bytes:
    """替换文件中的一条物理行（1-based）。"""
    assert len(new_line) == 80
    lines = data.split(newline)
    lines[lineno - 1] = new_line
    return newline.join(lines)


def d_line(entity_type: int, p_start: int, p_count: int, seq: int,
           first: bool) -> bytes:
    pair = make_d_pair(entity_type, p_start, p_count)
    body = pair[0] if first else pair[1]
    return body + b"D" + f"{seq:7d}".encode()


class TestValidFiles(unittest.TestCase):
    def test_comma_semicolon_minimal(self):
        data = build_file("1H,,1H;,7,8,9;", [(308, "308,7,5HAB,CD;")])
        self.assertEqual(error_codes(data), [])

    def test_pipe_bang_delimiters(self):
        data = build_file("1H||1H!|308|2.5!", [(110, "110|1.0|2Hxy!")])
        self.assertEqual(error_codes(data), [])

    def test_crlf_newlines(self):
        data = build_file(
            "1H,,1H;,7;", [(308, "308,1;")], newline="\r\n"
        )
        self.assertEqual(error_codes(data), [])

    def test_crlf_pipe_bang(self):
        data = build_file(
            "1H||1H!|9!", [(116, "116|3H!|x!")], newline="\r\n"
        )
        self.assertEqual(error_codes(data), [])

    def test_hollerith_spanning_lines_with_terminator_and_trailing_spaces(self):
        # 80 字符内容跨两条 P 记录：行尾带空格，内容含结束符 ';' 与分隔符 ','
        content = "A" * 49 + " " * 8 + "B;C,!D" + "E" * 17
        assert len(content) == 80
        p_data = f"308,{len(content)}H{content},1;"
        data = build_file("1H,,1H;,1;", [(308, p_data)])
        self.assertEqual(error_codes(data), [])

    def test_hollerith_trailing_spaces_before_separator(self):
        # 内容本身以空格结尾，内容后再跟空格与分隔符
        data = build_file("1H,,1H;,1;", [(308, "308,4Hab  ,  3Hxy  ;")])
        self.assertEqual(error_codes(data), [])

    def test_hollerith_content_contains_terminator_pipe_set(self):
        data = build_file("1H||1H!|1!", [(308, "308|5Ha!b,c!")])
        self.assertEqual(error_codes(data), [])

    def test_empty_params_and_surrounding_spaces(self):
        data = build_file("1H,,1H;,1;", [(308, " 308 ,, ,1;   ")])
        self.assertEqual(error_codes(data), [])

    def test_p_intervals_not_in_d_order(self):
        # P 区间排列与 D 出现顺序不同，仍应通过
        data = build_file(
            "1H,,1H;,1;",
            [(308, "308,1;"), (110, "110,2,3;")],
            p_order=[1, 0],
        )
        self.assertEqual(error_codes(data), [])

    def test_g_data_spanning_lines(self):
        g_data = "1H,,1H;," + ",".join(str(i) for i in range(100)) + ";"
        data = build_file(g_data, [(308, "308,1;")])
        self.assertEqual(error_codes(data), [])


class TestStructuralMismatch(unittest.TestCase):
    """行数与词法合法，但 D 指针 / P 归属 / 区间覆盖不一致。"""

    def test_d_pointer_out_of_range(self):
        # 实体声明首条 P 为 5，但 P 段只有 1 行
        data = build_file("1H,,1H;,1;", [(308, "308,1;")])
        data = patch_line(data, 3, d_line(308, 5, 1, 1, first=True))
        self.assertIn("E_P_RANGE", error_codes(data))

    def test_d_pointer_skips_p_record(self):
        # 实体 1 的 P 指针从 1 改为 2：P1 变成孤儿且与实体 2 区间重叠
        data = build_file(
            "1H,,1H;,1;", [(308, "308,1;"), (110, "110,2;")]
        )
        data = patch_line(data, 3, d_line(308, 2, 1, 1, first=True))
        codes = error_codes(data)
        self.assertIn("E_P_OVERLAP", codes)
        self.assertIn("E_P_ORPHAN", codes)

    def test_p_owner_not_pointing_back(self):
        data = build_file("1H,,1H;,1;", [(308, "308,1;")])
        bad_p = make_p_line("308,1;", 99, 1)
        data = patch_line(data, 5, bad_p)
        self.assertIn("E_P_OWNER", error_codes(data))

    def test_intervals_overlap(self):
        # 实体 2 的 P 指针改指实体 1 的区间
        data = build_file(
            "1H,,1H;,1;", [(308, "308,1;"), (110, "110,2;")]
        )
        data = patch_line(data, 5, d_line(110, 1, 1, 3, first=True))
        codes = error_codes(data)
        self.assertIn("E_P_OVERLAP", codes)
        self.assertIn("E_P_ORPHAN", codes)

    def test_interval_extends_beyond_p_section(self):
        # 参数行数从 1 改为 3，区间越界
        data = build_file("1H,,1H;,1;", [(308, "308,1;")])
        data = patch_line(data, 4, d_line(308, 1, 3, 2, first=False))
        self.assertIn("E_P_RANGE", error_codes(data))

    def test_p_record_uncovered(self):
        # 实体 2 的 P 指针从 2 改为 3，越界（只有 2 行 P），P2 成为孤儿
        data = build_file("1H,,1H;,1;", [(308, "308,1;"), (110, "110,2;")])
        data = patch_line(data, 5, d_line(110, 3, 1, 3, first=True))
        codes = error_codes(data)
        self.assertIn("E_P_RANGE", codes)
        self.assertIn("E_P_ORPHAN", codes)


class TestHollerithRejection(unittest.TestCase):
    def test_hollerith_content_shorter_than_declared_in_p(self):
        # 声明 70 字节内容，但 P 数据剩余不足 70 字节
        data = build_file("1H,,1H;,1;", [(308, "308,70Hab;")])
        self.assertIn("E_HOLLERITH", error_codes(data))

    def test_hollerith_content_shorter_than_declared_in_g(self):
        data = build_file("1H,,1H;,99Hab;", [(308, "308,1;")])
        self.assertIn("E_HOLLERITH", error_codes(data))

    def test_hollerith_garbage_after_content(self):
        # 内容之后只能有空格和一个分隔符，出现其他字符应拒绝
        data = build_file("1H,,1H;,1;", [(308, "308,2Habx,1;")])
        self.assertIn("E_SEP", error_codes(data))


class TestLexicalRejection(unittest.TestCase):
    def test_missing_terminator(self):
        data = build_file("1H,,1H;,1;", [(308, "308,1")])
        self.assertIn("E_TERM", error_codes(data))

    def test_content_after_terminator(self):
        data = build_file("1H,,1H;,1;", [(308, "308,1;9")])
        self.assertIn("E_TERM", error_codes(data))

    def test_first_param_not_entity_type(self):
        data = build_file("1H,,1H;,1;", [(308, "110,1;")])
        self.assertIn("E_P_TYPE", error_codes(data))

    def test_t_count_mismatch(self):
        data = build_file("1H,,1H;,1;", [(308, "308,1;")])
        bad_t = make_line(f"S{2:7d}G{1:7d}D{2:7d}P{1:7d}", "T", 1)
        data = patch_line(data, 6, bad_t)
        self.assertIn("E_T_COUNT", error_codes(data))

    def test_bad_line_width(self):
        data = build_file("1H,,1H;,1;", [(308, "308,1;")])
        lines = data.split(b"\n")
        lines[0] = lines[0][:79]
        self.assertIn("E_LINE_WIDTH", error_codes(b"\n".join(lines)))

    def test_mixed_newlines(self):
        data = build_file("1H,,1H;,1;", [(308, "308,1;")], newline="\r\n")
        data = data.replace(b"\r\n", b"\n", 1)  # 首行变成裸 LF
        self.assertIn("E_NEWLINE", error_codes(data))

    def test_unsupported_g_header(self):
        data = build_file("1H,,1H@,1;", [(308, "308,1;")])
        self.assertIn("E_G_HEADER", error_codes(data))

    def test_d_second_line_type_mismatch(self):
        data = build_file("1H,,1H;,1;", [(308, "308,1;")])
        data = patch_line(data, 4, d_line(110, 1, 1, 2, first=False))
        self.assertIn("E_D_TYPE", error_codes(data))


class TestFileEntry(unittest.TestCase):
    def test_precheck_file_roundtrip(self):
        data = build_file(
            "1H,,1H;,7;", [(308, "308,3Hab ;")], newline="\r\n"
        )
        with tempfile.NamedTemporaryFile(suffix=".igs", delete=False) as handle:
            handle.write(data)
            path = handle.name
        try:
            result = precheck_file(path)
            self.assertTrue(result.ok, [e.message for e in result.errors])
        finally:
            Path(path).unlink()


if __name__ == "__main__":
    unittest.main()
