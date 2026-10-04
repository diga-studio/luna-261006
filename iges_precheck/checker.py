"""预检主流程：串联各段校验并给出最终判定。"""
from __future__ import annotations

from pathlib import Path

from .directory import EntityDir, parse_entities, parse_int_field
from .errors import IgesPrecheckError
from .params import detect_delimiters, parse_parameters
from .sections import Sections, parse_sections, split_lines


def validate_bytes(raw: bytes) -> None:
    """对文件内容执行全部预检；失败抛出 IgesPrecheckError。"""
    sections = parse_sections(split_lines(raw))
    g_data = "".join(line.data for line in sections.g)
    delims = detect_delimiters(g_data)
    parse_parameters(g_data, delims)
    entities = parse_entities(sections.d)
    _check_p_coverage(sections, entities)
    _check_entity_params(sections, entities, delims)
    _check_terminate(sections)


def _check_p_coverage(sections: Sections, entities: list[EntityDir]) -> None:
    """校验 P 区间不越界、不重叠、无遗漏，且归属字段指回所属实体。"""
    p_lines = sections.p
    owners = [parse_int_field(line.data[64:72]) for line in p_lines]
    covered: list[int | None] = [None] * len(p_lines)
    for entity in entities:
        last_p = entity.first_p + entity.param_lines - 1
        if entity.first_p < 1 or last_p > len(p_lines):
            raise IgesPrecheckError(
                f"实体（D 序号 {entity.d_seq}）的 P 区间越界"
            )
        for p_seq in range(entity.first_p, last_p + 1):
            index = p_seq - 1
            if covered[index] is not None:
                raise IgesPrecheckError(f"P 记录 {p_seq} 被多个实体覆盖")
            covered[index] = entity.d_seq
            if owners[index] != entity.d_seq:
                raise IgesPrecheckError(
                    f"P 记录 {p_seq} 的归属字段未指向实体（D 序号 {entity.d_seq}）"
                )
    for index, owner in enumerate(covered):
        if owner is None:
            raise IgesPrecheckError(f"P 记录 {index + 1} 未被任何实体覆盖")


def _check_entity_params(
    sections: Sections, entities: list[EntityDir], delims
) -> None:
    """校验每个实体 P 数据的结束符与首个参数（实体类型）。"""
    p_data = [line.data[:64] for line in sections.p]
    for entity in entities:
        start = entity.first_p - 1
        data = "".join(p_data[start : start + entity.param_lines])
        params = parse_parameters(data, delims)
        first = params[0].strip() if params else ""
        if first != str(entity.type_id):
            raise IgesPrecheckError(
                f"实体（D 序号 {entity.d_seq}）首个参数 {first!r} "
                f"与目录类型 {entity.type_id} 不一致"
            )


def _check_terminate(sections: Sections) -> None:
    """校验 T 段前 32 列的四组段行数统计。"""
    data = sections.t.data
    counts = {
        "S": len(sections.s),
        "G": len(sections.g),
        "D": len(sections.d),
        "P": len(sections.p),
    }
    for index, letter in enumerate("SGDP"):
        field = data[index * 8 : (index + 1) * 8]
        if field[0] != letter:
            raise IgesPrecheckError(f"T 段第 {index + 1} 个字段应为字母 {letter}")
        if parse_int_field(field[1:8]) != counts[letter]:
            raise IgesPrecheckError(f"T 段统计的 {letter} 段行数与实际不符")


def validate_file(path: str | Path) -> None:
    """读取本地文件并执行预检；失败抛出 IgesPrecheckError。"""
    validate_bytes(Path(path).read_bytes())


def is_valid_file(path: str | Path) -> bool:
    """返回文件是否通过预检。"""
    try:
        validate_file(path)
    except IgesPrecheckError:
        return False
    return True
