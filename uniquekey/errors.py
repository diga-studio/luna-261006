"""异常定义。"""


class UniqueKeyError(Exception):
    """库的基础异常。"""


class ConflictError(UniqueKeyError):
    """保存的内容与现存条目在生效规则下冲突。"""


class SwitchConflictError(UniqueKeyError):
    """候选规则下现存条目存在冲突，切换失败。"""


class RuleError(UniqueKeyError):
    """规则本身不合法（如字段列表为空）。"""
