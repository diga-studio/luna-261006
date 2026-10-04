"""构造合法/非法 IGES 文本的测试辅助函数。"""
from __future__ import annotations


def rec(section: str, seq: int, data: str = "") -> str:
    """普通 80 列记录：第 1-72 列数据 + 段名 + 7 列序号。"""
    return data.ljust(72)[:72] + section + str(seq).rjust(7)


def p_rec(seq: int, data: str, owner: int) -> str:
    """P 段记录：第 1-64 列数据，第 65-72 列为所属实体首条 D 序号。"""
    return data.ljust(64)[:64] + str(owner).rjust(8) + "P" + str(seq).rjust(7)


def d_pair(seq: int, type_id: int, p_start: int, p_count: int,
           second_type: int | None = None) -> list[str]:
    """一个实体的两条 D 记录。"""
    line1 = str(type_id).rjust(8) + str(p_start).rjust(8) + " " * 56
    line2_type = type_id if second_type is None else second_type
    line2 = str(line2_type).rjust(8) + " " * 16 + str(p_count).rjust(8) + " " * 40
    return [rec("D", seq, line1), rec("D", seq + 1, line2)]


def t_rec(n_s: int, n_g: int, n_d: int, n_p: int) -> str:
    """T 段记录：前 32 列为 S/G/D/P 四组行数统计。"""
    data = (
        "S" + str(n_s).rjust(7)
        + "G" + str(n_g).rjust(7)
        + "D" + str(n_d).rjust(7)
        + "P" + str(n_p).rjust(7)
    )
    return rec("T", 1, data)


def make_file(lines: list[str], newline: str = "\n",
              final_newline: bool = True) -> bytes:
    """把记录列表拼成文件字节。"""
    text = newline.join(lines)
    if final_newline:
        text += newline
    return text.encode("ascii")
