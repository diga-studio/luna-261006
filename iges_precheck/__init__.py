"""IGES 结构预检库：转换前由上层直接调用。"""
from .checker import is_valid_file, validate_bytes, validate_file
from .errors import IgesPrecheckError

__all__ = [
    "IgesPrecheckError",
    "is_valid_file",
    "validate_bytes",
    "validate_file",
]
