"""原始行切分与段（S/G/D/P/T）结构解析。"""
from __future__ import annotations

import re
from dataclasses import dataclass

from .errors import IgesPrecheckError

SECTION_ORDER = "SGDPT"

_SEQ_FIELD_RE = re.compile(r"^ *\d+$")


@dataclass(frozen=True)
class RawLine:
    """一条 80 列记录：段名、段内序号、第 1-72 列数据。"""

    section: str
    seq: int
    data: str


@dataclass(frozen=True)
class Sections:
    """按段分组后的全部记录；T 段恰好一行。"""

    s: list[RawLine]
    g: list[RawLine]
    d: list[RawLine]
    p: list[RawLine]
    t: RawLine


def split_lines(raw: bytes) -> list[str]:
    """把文件字节切成 80 列文本行，校验 ASCII 与换行风格统一。"""
    if not raw:
        raise IgesPrecheckError("文件为空")
    try:
        text = raw.decode("ascii")
    except UnicodeDecodeError as exc:
        raise IgesPrecheckError("文件不是 ASCII 文本") from exc
    if "\r\n" in text:
        rest = text.replace("\r\n", "")
        if "\n" in rest or "\r" in rest:
            raise IgesPrecheckError("文件混用 LF 与 CRLF 换行")
        lines = text.split("\r\n")
    else:
        if "\r" in text:
            raise IgesPrecheckError("文件含孤立的 CR 字符")
        lines = text.split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    if not lines:
        raise IgesPrecheckError("文件没有有效行")
    for lineno, line in enumerate(lines, 1):
        if len(line) != 80:
            raise IgesPrecheckError(
                f"第 {lineno} 行长度为 {len(line)}，不是 80 字节"
            )
    return lines


def parse_sections(lines: list[str]) -> Sections:
    """校验段名、段顺序与各段序号连续性，并按段分组。"""
    grouped: dict[str, list[RawLine]] = {name: [] for name in SECTION_ORDER}
    last_rank = -1
    for lineno, line in enumerate(lines, 1):
        section = line[72]
        if section not in SECTION_ORDER:
            raise IgesPrecheckError(f"第 {lineno} 行段名非法：{section!r}")
        rank = SECTION_ORDER.index(section)
        if rank < last_rank:
            raise IgesPrecheckError(f"第 {lineno} 行段 {section} 出现顺序错误")
        last_rank = rank
        seq_text = line[73:80]
        if not _SEQ_FIELD_RE.match(seq_text):
            raise IgesPrecheckError(f"第 {lineno} 行段内序号非法：{seq_text!r}")
        seq = int(seq_text)
        expected = len(grouped[section]) + 1
        if seq != expected:
            raise IgesPrecheckError(
                f"第 {lineno} 行段 {section} 序号应为 {expected}，实际为 {seq}"
            )
        grouped[section].append(RawLine(section=section, seq=seq, data=line[:72]))
    for name in SECTION_ORDER:
        if not grouped[name]:
            raise IgesPrecheckError(f"缺少 {name} 段")
    if len(grouped["T"]) != 1:
        raise IgesPrecheckError("T 段必须恰好一行")
    return Sections(
        s=grouped["S"],
        g=grouped["G"],
        d=grouped["D"],
        p=grouped["P"],
        t=grouped["T"][0],
    )
