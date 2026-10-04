"""预检失败时抛出的异常类型。"""


class IgesPrecheckError(ValueError):
    """IGES 文件结构预检失败。"""
