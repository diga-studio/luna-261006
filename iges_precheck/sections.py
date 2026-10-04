"""行切分与 S/G/D/P/T 段划分。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Tuple

from .errors import PrecheckResult
from .fields import parse_int_field

# 物理行：内容恰好 80 字节（不含换行符）
RawLine = Tuple[int, bytes]  # (1-based 行号, 80 字节内容)

SECTION_ORDER = ("S", "G", "D", "P", "T")
LINE_WIDTH = 80
SECTION_COL = 72  # 第 73 列（0-based）


@dataclass
class SectionedFile:
    """按段划分后的文件结构。"""

    lines: List[RawLine]
    # 段名 -> 该段物理行列表（保持文件顺序）
    sections: Dict[str, List[RawLine]]


def split_lines(data: bytes, result: PrecheckResult) -> List[RawLine]:
    """把原始字节切成 80 字节物理行，校验换行风格统一。"""
    if not data:
        result.add("E_EMPTY", "文件为空")
        return []
    if any(byte > 0x7F for byte in data):
        result.add("E_ENCODING", "文件不是纯 ASCII 文本")
        return []

    if b"\r\n" in data:
        # CRLF 风格：不允许出现裸 \n 或裸 \r
        for idx, byte in enumerate(data):
            if byte == 0x0A and (idx == 0 or data[idx - 1] != 0x0D):
                result.add("E_NEWLINE", "换行风格不统一：CRLF 文件中存在裸 LF")
                return []
            if byte == 0x0D and (idx + 1 >= len(data) or data[idx + 1] != 0x0A):
                result.add("E_NEWLINE", "换行风格不统一：存在裸 CR")
                return []
        newline = b"\r\n"
    else:
        if b"\r" in data:
            result.add("E_NEWLINE", "换行风格不统一：存在裸 CR")
            return []
        newline = b"\n"

    parts = data.split(newline)
    if parts and parts[-1] == b"":
        parts.pop()  # 末行带换行
    lines: List[RawLine] = []
    for lineno, part in enumerate(parts, start=1):
        if len(part) != LINE_WIDTH:
            result.add(
                "E_LINE_WIDTH",
                f"物理行长度应为 {LINE_WIDTH} 字节，实际 {len(part)} 字节",
                line=lineno,
            )
            return []
        lines.append((lineno, part))
    return lines


def split_sections(lines: List[RawLine], result: PrecheckResult) -> SectionedFile:
    """按第 73 列段名划分五段，校验顺序、非空与段内序号连续。"""
    sections: Dict[str, List[RawLine]] = {name: [] for name in SECTION_ORDER}
    order_index = {name: idx for idx, name in enumerate(SECTION_ORDER)}
    current = -1
    ok = True
    for lineno, content in lines:
        letter = chr(content[SECTION_COL])
        if letter not in order_index:
            result.add("E_SECTION", f"未知的段名 {letter!r}", line=lineno)
            ok = False
            continue
        idx = order_index[letter]
        if idx < current:
            result.add("E_SECTION_ORDER", f"段 {letter} 出现在其前驱段之前", line=lineno)
            ok = False
            continue
        current = idx
        seq_field = content[SECTION_COL + 1:].decode("ascii")
        seq = parse_int_field(seq_field)
        if seq is None:
            result.add("E_SEQ", f"段 {letter} 序号字段不是前补空格的十进制整数", line=lineno)
            ok = False
            continue
        expected = len(sections[letter]) + 1
        if seq != expected:
            result.add(
                "E_SEQ",
                f"段 {letter} 序号应从 1 连续递增，期望 {expected}，实际 {seq}",
                line=lineno,
            )
            ok = False
            continue
        sections[letter].append((lineno, content))

    for name in SECTION_ORDER:
        if not sections[name]:
            result.add("E_SECTION", f"缺少 {name} 段或该段为空")
            ok = False
    if len(sections["T"]) > 1:
        result.add("E_SECTION", "T 段只能有一行", line=sections["T"][1][0])
        ok = False

    return SectionedFile(lines=lines, sections=sections)
