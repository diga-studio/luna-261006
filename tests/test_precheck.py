"""IGES 结构预检库的自动化测试。"""
from __future__ import annotations

import pytest

from iges_precheck import (
    IgesPrecheckError,
    is_valid_file,
    validate_bytes,
    validate_file,
)

from helpers import d_pair, make_file, p_rec, rec, t_rec


def baseline_lines() -> list[str]:
    """最小合法文件：逗号/分号分隔符，两个实体。"""
    lines = [rec("S", 1)]
    lines.append(rec("G", 1, "1H,,1H;,0,0,;"))
    lines += d_pair(1, 308, 1, 1)
    lines += d_pair(3, 410, 2, 1)
    lines.append(p_rec(1, "308,;", 1))
    lines.append(p_rec(2, "410,;", 3))
    lines.append(t_rec(1, 1, 4, 2))
    return lines


# ---------------------------------------------------------------- 合法文件


def test_valid_comma_semicolon_lf():
    validate_bytes(make_file(baseline_lines(), newline="\n"))


def test_valid_pipe_bang_crlf_without_final_newline():
    lines = [rec("S", 1)]
    lines.append(rec("G", 1, "1H||1H!|0|0|!"))
    lines += d_pair(1, 308, 1, 1)
    lines.append(p_rec(1, "308|!", 1))
    lines.append(t_rec(1, 1, 2, 1))
    validate_bytes(make_file(lines, newline="\r\n", final_newline=False))


def test_valid_hollerith_spanning_lines_with_terminator_and_trailing_spaces():
    # 70H 字符串跨两条 P 记录：内容含结束符 ';'，且行尾两个空格属于内容。
    line1_data = "308,70H" + "A" * 55 + "  "
    assert len(line1_data) == 64
    line2_data = "A;B" + "A" * 10 + ",;"
    lines = [rec("S", 1)]
    lines.append(rec("G", 1, "1H,,1H;,0,;"))
    lines += d_pair(1, 308, 1, 2)
    lines.append(p_rec(1, line1_data, 1))
    lines.append(p_rec(2, line2_data, 1))
    lines.append(t_rec(1, 1, 2, 2))
    validate_bytes(make_file(lines))


def test_valid_empty_params_and_surrounding_spaces():
    lines = [rec("S", 1)]
    lines.append(rec("G", 1, "1H,,1H;, , 0 ,;"))
    lines += d_pair(1, 308, 1, 1)
    lines.append(p_rec(1, " 308 , , 1 , ;", 1))
    lines.append(t_rec(1, 1, 2, 1))
    validate_bytes(make_file(lines))


def test_valid_p_intervals_not_in_d_order():
    # 实体声明顺序与 P 区间顺序相反，仍然合法。
    lines = [rec("S", 1)]
    lines.append(rec("G", 1, "1H,,1H;,0,;"))
    lines += d_pair(1, 410, 2, 1)
    lines += d_pair(3, 308, 1, 1)
    lines.append(p_rec(1, "308,;", 3))
    lines.append(p_rec(2, "410,;", 1))
    lines.append(t_rec(1, 1, 4, 2))
    validate_bytes(make_file(lines))


def test_valid_file_on_disk(tmp_path):
    path = tmp_path / "part.igs"
    path.write_bytes(make_file(baseline_lines()))
    validate_file(path)
    assert is_valid_file(path)


# ---------------------------------------------------------------- 非法文件


def test_reject_d_pointer_out_of_range():
    lines = [rec("S", 1)]
    lines.append(rec("G", 1, "1H,,1H;,0,;"))
    lines += d_pair(1, 308, 5, 1)
    lines.append(p_rec(1, "308,;", 1))
    lines.append(t_rec(1, 1, 2, 1))
    with pytest.raises(IgesPrecheckError):
        validate_bytes(make_file(lines))


def test_reject_d_second_line_type_mismatch():
    lines = [rec("S", 1)]
    lines.append(rec("G", 1, "1H,,1H;,0,;"))
    lines += d_pair(1, 308, 1, 1, second_type=309)
    lines.append(p_rec(1, "308,;", 1))
    lines.append(t_rec(1, 1, 2, 1))
    with pytest.raises(IgesPrecheckError):
        validate_bytes(make_file(lines))


def test_reject_p_owner_mismatch():
    lines = [rec("S", 1)]
    lines.append(rec("G", 1, "1H,,1H;,0,;"))
    lines += d_pair(1, 308, 1, 1)
    lines.append(p_rec(1, "308,;", 3))
    lines.append(t_rec(1, 1, 2, 1))
    with pytest.raises(IgesPrecheckError):
        validate_bytes(make_file(lines))


def test_reject_p_interval_overlap():
    lines = [rec("S", 1)]
    lines.append(rec("G", 1, "1H,,1H;,0,;"))
    lines += d_pair(1, 308, 1, 1)
    lines += d_pair(3, 410, 1, 1)
    lines.append(p_rec(1, "308,;", 1))
    lines.append(t_rec(1, 1, 4, 1))
    with pytest.raises(IgesPrecheckError):
        validate_bytes(make_file(lines))


def test_reject_p_record_uncovered():
    lines = [rec("S", 1)]
    lines.append(rec("G", 1, "1H,,1H;,0,;"))
    lines += d_pair(1, 308, 1, 1)
    lines.append(p_rec(1, "308,;", 1))
    lines.append(p_rec(2, "308,;", 1))
    lines.append(t_rec(1, 1, 2, 2))
    with pytest.raises(IgesPrecheckError):
        validate_bytes(make_file(lines))


def test_reject_hollerith_content_shorter_than_declared():
    lines = [rec("S", 1)]
    lines.append(rec("G", 1, "1H,,1H;,0,;"))
    lines += d_pair(1, 308, 1, 1)
    lines.append(p_rec(1, "308,99HABC,;", 1))
    lines.append(t_rec(1, 1, 2, 1))
    with pytest.raises(IgesPrecheckError):
        validate_bytes(make_file(lines))


def test_reject_entity_first_param_type_mismatch():
    lines = [rec("S", 1)]
    lines.append(rec("G", 1, "1H,,1H;,0,;"))
    lines += d_pair(1, 308, 1, 1)
    lines.append(p_rec(1, "309,;", 1))
    lines.append(t_rec(1, 1, 2, 1))
    with pytest.raises(IgesPrecheckError):
        validate_bytes(make_file(lines))


def test_reject_t_count_mismatch():
    lines = baseline_lines()
    lines[-1] = t_rec(1, 1, 4, 3)
    with pytest.raises(IgesPrecheckError):
        validate_bytes(make_file(lines))


def test_reject_missing_terminator_in_p_data():
    lines = [rec("S", 1)]
    lines.append(rec("G", 1, "1H,,1H;,0,;"))
    lines += d_pair(1, 308, 1, 1)
    lines.append(p_rec(1, "308,1,2", 1))
    lines.append(t_rec(1, 1, 2, 1))
    with pytest.raises(IgesPrecheckError):
        validate_bytes(make_file(lines))


def test_reject_invalid_file_on_disk(tmp_path):
    path = tmp_path / "bad.igs"
    lines = baseline_lines()
    lines[-1] = t_rec(9, 9, 9, 9)
    path.write_bytes(make_file(lines))
    assert not is_valid_file(path)
    with pytest.raises(IgesPrecheckError):
        validate_file(path)
