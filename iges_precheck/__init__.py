"""IGES 结构预检库：转换前判断文件结构是否完整。"""

from .checker import precheck_bytes, precheck_file
from .errors import PrecheckError, PrecheckResult

__all__ = ["precheck_bytes", "precheck_file", "PrecheckError", "PrecheckResult"]
