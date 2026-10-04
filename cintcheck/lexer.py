"""Tokenizer for C integer constant expressions."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import List


@dataclass(frozen=True)
class Token:
    kind: str  # 'num', 'ident', 'op', 'lparen', 'rparen', 'question', 'colon', 'eof'
    text: str


_NUM_RE = re.compile(
    r"""
    0[xX][0-9a-fA-F]+[uUlL]*   # hex
    |0[0-7]*[uUlL]*            # octal (incl. plain 0)
    |[1-9][0-9]*[uUlL]*        # decimal
    """,
    re.VERBOSE,
)
_IDENT_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")

_MULTI_OPS = ("<<=", ">>=", "&&", "||", "<<", ">>", "<=", ">=", "==", "!=")
_SINGLE_OPS = set("+-*/%<>&^|~!")


def tokenize(text: str) -> List[Token]:
    tokens: List[Token] = []
    pos = 0
    n = len(text)
    while pos < n:
        ch = text[pos]
        if ch.isspace():
            pos += 1
            continue
        m = _NUM_RE.match(text, pos)
        if m:
            tokens.append(Token("num", m.group(0)))
            pos = m.end()
            continue
        m = _IDENT_RE.match(text, pos)
        if m:
            tokens.append(Token("ident", m.group(0)))
            pos = m.end()
            continue
        if ch == "(":
            tokens.append(Token("lparen", ch))
            pos += 1
            continue
        if ch == ")":
            tokens.append(Token("rparen", ch))
            pos += 1
            continue
        if ch == "?":
            tokens.append(Token("question", ch))
            pos += 1
            continue
        if ch == ":":
            tokens.append(Token("colon", ch))
            pos += 1
            continue
        matched = False
        for op in _MULTI_OPS:
            if text.startswith(op, pos):
                tokens.append(Token("op", op))
                pos += len(op)
                matched = True
                break
        if matched:
            continue
        if ch in _SINGLE_OPS:
            tokens.append(Token("op", ch))
            pos += 1
            continue
        raise ValueError(f"unexpected character {ch!r} at offset {pos}")
    tokens.append(Token("eof", ""))
    return tokens
