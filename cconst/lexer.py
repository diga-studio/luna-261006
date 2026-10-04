"""词法分析：把常量表达式文本切分为 token 序列。"""

from __future__ import annotations

import re
from dataclasses import dataclass
from enum import Enum, auto


class TokenKind(Enum):
    INT_LITERAL = auto()
    IDENT = auto()       # 类型名关键字（char/short/int/long/signed/unsigned）
    LPAREN = auto()
    RPAREN = auto()
    OP = auto()          # 运算符与 ? :
    EOF = auto()


@dataclass(frozen=True)
class Token:
    kind: TokenKind
    text: str
    pos: int


class LexError(ValueError):
    pass


_INT_LITERAL_RE = re.compile(
    r"""
    (?: 0[xX][0-9a-fA-F]+      # 十六进制
      | 0[0-7]*                # 八进制（含单个 0）
      | [1-9][0-9]*            # 十进制
    )
    (?: [uU](?:ll|LL|lL|Ll|[lL])?   # 后缀：u 可搭配 l/ll
      | (?:ll|LL|lL|Ll|[lL])[uU]?   # 或 l/ll 可搭配 u
    )?
    """,
    re.VERBOSE,
)

_TYPE_KEYWORDS = frozenset({"char", "short", "int", "long", "signed", "unsigned"})

# 按长度降序匹配，保证多字符运算符优先。
_OPERATORS = (
    "<<", ">>", "<=", ">=", "==", "!=", "&&", "||",
    "+", "-", "*", "/", "%", "<", ">", "&", "^", "|", "~", "!", "?", ":",
)


def tokenize(text: str) -> list[Token]:
    tokens: list[Token] = []
    pos = 0
    length = len(text)
    while pos < length:
        ch = text[pos]
        if ch.isspace():
            pos += 1
            continue
        match = _INT_LITERAL_RE.match(text, pos)
        if match is not None:
            tokens.append(Token(TokenKind.INT_LITERAL, match.group(0), pos))
            pos = match.end()
            continue
        if ch == "(":
            tokens.append(Token(TokenKind.LPAREN, ch, pos))
            pos += 1
            continue
        if ch == ")":
            tokens.append(Token(TokenKind.RPAREN, ch, pos))
            pos += 1
            continue
        if ch.isalpha() or ch == "_":
            end = pos + 1
            while end < length and (text[end].isalnum() or text[end] == "_"):
                end += 1
            word = text[pos:end]
            if word not in _TYPE_KEYWORDS:
                raise LexError(f"unexpected identifier {word!r} at offset {pos}")
            tokens.append(Token(TokenKind.IDENT, word, pos))
            pos = end
            continue
        for op in _OPERATORS:
            if text.startswith(op, pos):
                tokens.append(Token(TokenKind.OP, op, pos))
                pos += len(op)
                break
        else:
            raise LexError(f"unexpected character {ch!r} at offset {pos}")
    tokens.append(Token(TokenKind.EOF, "", length))
    return tokens
