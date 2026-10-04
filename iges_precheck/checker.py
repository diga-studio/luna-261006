"""预检编排：把各阶段检查串起来。"""

from __future__ import annotations

from typing import List

from .entities import check_p_coverage, parse_d_records
from .errors import PrecheckResult
from .fields import parse_int_field
from .params import parse_global_header, parse_params
from .sections import RawLine, split_lines, split_sections


def precheck_bytes(data: bytes) -> PrecheckResult:
    """对 IGES 文件字节内容做结构预检。"""
    result = PrecheckResult()

    lines = split_lines(data, result)
    if not result.ok:
        return result
    sectioned = split_sections(lines, result)
    if not result.ok:
        return result
    sections = sectioned.sections

    # G 段：拼接第 1-72 列，解析分隔符声明并校验整体词法
    g_data = "".join(content[0:72].decode("ascii") for _, content in sections["G"])
    delimiters = parse_global_header(g_data, result)
    if not result.ok or delimiters is None:
        return result
    parse_params(g_data, delimiters, result, "G 段")
    if not result.ok:
        return result

    # D 段：解析实体结构
    entities = parse_d_records(sections["D"], result)
    if not result.ok:
        return result

    # P 段：区间连续、归属指回、全覆盖不重叠
    p_lines: List[RawLine] = sections["P"]
    check_p_coverage(entities, p_lines, result)
    if not result.ok:
        return result

    # 每个实体：拼接 P 数据（第 1-64 列）做词法校验，首参数须等于实体类型
    for entity in entities:
        interval = p_lines[entity.p_start - 1: entity.p_start - 1 + entity.p_count]
        p_data = "".join(content[0:64].decode("ascii") for _, content in interval)
        context = f"实体 {entity.entity_type}（D 序号 {entity.de_seq}）的 P 数据"
        parsed = parse_params(p_data, delimiters, result, context)
        if not parsed.ok:
            continue
        first = parsed.params[0] if parsed.params else None
        if first != str(entity.entity_type):
            result.add(
                "E_P_TYPE",
                f"{context}：首个参数 {first!r} 与 D 记录实体类型 "
                f"{entity.entity_type} 不一致",
            )
    if not result.ok:
        return result

    # T 段：第 1-32 列为 S/G/D/P 字母加 7 列行数
    t_lineno, t_content = sections["T"][0]
    t_data = t_content[0:72].decode("ascii")
    for index, name in enumerate(("S", "G", "D", "P")):
        field = t_data[index * 8:(index + 1) * 8]
        if field[0] != name:
            result.add(
                "E_T_FIELD",
                f"T 记录第 {index * 8 + 1}-{index * 8 + 8} 列应以字母 {name} 开头",
                line=t_lineno,
            )
            continue
        count = parse_int_field(field[1:8])
        actual = len(sections[name])
        if count is None:
            result.add("E_T_FIELD", f"T 记录 {name} 段行数字段格式非法", line=t_lineno)
        elif count != actual:
            result.add(
                "E_T_COUNT",
                f"T 记录声明 {name} 段 {count} 行，实际 {actual} 行",
                line=t_lineno,
            )
    return result


def precheck_file(path: str) -> PrecheckResult:
    """读取本地文件并做结构预检。"""
    with open(path, "rb") as handle:
        return precheck_bytes(handle.read())
