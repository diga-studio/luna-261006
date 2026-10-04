"""语法分析：递归下降解析 C11 常量表达式子集，生成 AST。"""

from __future__ import annotations

from dataclasses import dataclass

from . import ctypes
from .ctypes import CType
from .lexer import LexError, Token, TokenKind, tokenize


class ParseError(ValueError):
    pass


# --- AST 节点 ---


@dataclass(frozen=True)
class Literal:
    text: str        # 原始字面量文本（含后缀）
    value: int       # 数学值
    ctype: CType     # 按 C11 6.4.4.1 确定的字面量类型


@dataclass(frozen=True)
class Cast:
    target: CType
    operand: "Node"


@dataclass(frozen=True)
class Unary:
    op: str  # '+', '-', '~', '!'
    operand: "Node"


@dataclass(frozen=True)
class Binary:
    op: str
    left: "Node"
    right: "Node"


@dataclass(frozen=True)
class Conditional:
    cond: "Node"
    then: "Node"
    otherwise: "Node"


Node = Literal | Cast | Unary | Binary | Conditional


def _parse_literal(token: Token) -> Literal:
    digits, suffix = ctypes.split_suffix(token.text)
    if digits.lower().startswith("0x"):
        base = 16
    elif len(digits) > 1 and digits.startswith("0"):
        base = 8
    elif digits == "0":
        base = 8  # 单个 0 是八进制，但候选类型结果相同，按十进制处理亦可
        base = 10
    else:
        base = 10
    try:
        value = int(digits, base)
    except ValueError as exc:  # 如 08 之类非法输入
        raise ParseError(f"invalid integer literal {token.text!r}") from exc
    try:
        ctype = ctypes.literal_type(value, base, suffix)
    except ValueError as exc:
        raise ParseError(str(exc)) from exc
    return Literal(token.text, value, ctype)


def _parse_type_name(words: list[str]) -> CType:
    """把 'unsigned long long' 之类的类型名序列映射为 CType。"""
    if not words:
        raise ParseError("empty type name in cast")
    if "signed" in words and "unsigned" in words:
        raise ParseError(f"conflicting type specifiers: {' '.join(words)}")
    signed = "unsigned" not in words
    long_count = words.count("long")
    others = [w for w in words if w not in ("signed", "unsigned", "int", "long")]
    if len(others) > 1 or long_count > 2:
        raise ParseError(f"invalid type name: {' '.join(words)}")
    if others:
        if long_count:
            raise ParseError(f"invalid type name: {' '.join(words)}")
        rank = {"char": ctypes.Rank.CHAR, "short": ctypes.Rank.SHORT}[others[0]]
    elif long_count == 2:
        rank = ctypes.Rank.LLONG
    elif long_count == 1:
        rank = ctypes.Rank.LONG
    else:
        rank = ctypes.Rank.INT
    return ctypes.canonical(CType(rank, signed))


class _Parser:
    def __init__(self, tokens: list[Token]):
        self._tokens = tokens
        self._index = 0

    @property
    def _current(self) -> Token:
        return self._tokens[self._index]

    def _advance(self) -> Token:
        token = self._tokens[self._index]
        self._index += 1
        return token

    def _expect_op(self, op: str) -> Token:
        token = self._current
        if token.kind is not TokenKind.OP or token.text != op:
            raise ParseError(f"expected {op!r} at offset {token.pos}")
        return self._advance()

    def _at_op(self, *ops: str) -> bool:
        token = self._current
        return token.kind is TokenKind.OP and token.text in ops

    # --- 各优先级 ---

    def parse_expression(self) -> Node:
        return self._parse_conditional()

    def _parse_conditional(self) -> Node:
        cond = self._parse_logical_or()
        if self._at_op("?"):
            self._advance()
            then = self._parse_conditional()
            self._expect_op(":")
            otherwise = self._parse_conditional()
            return Conditional(cond, then, otherwise)
        return cond

    def _parse_binary_level(self, sub, ops: tuple[str, ...]) -> Node:
        node = sub()
        while self._at_op(*ops):
            op = self._advance().text
            node = Binary(op, node, sub())
        return node

    def _parse_logical_or(self) -> Node:
        return self._parse_binary_level(self._parse_logical_and, ("||",))

    def _parse_logical_and(self) -> Node:
        return self._parse_binary_level(self._parse_inclusive_or, ("&&",))

    def _parse_inclusive_or(self) -> Node:
        return self._parse_binary_level(self._parse_exclusive_or, ("|",))

    def _parse_exclusive_or(self) -> Node:
        return self._parse_binary_level(self._parse_and, ("^",))

    def _parse_and(self) -> Node:
        return self._parse_binary_level(self._parse_equality, ("&",))

    def _parse_equality(self) -> Node:
        return self._parse_binary_level(self._parse_relational, ("==", "!="))

    def _parse_relational(self) -> Node:
        return self._parse_binary_level(self._parse_shift, ("<", ">", "<=", ">="))

    def _parse_shift(self) -> Node:
        return self._parse_binary_level(self._parse_additive, ("<<", ">>"))

    def _parse_additive(self) -> Node:
        return self._parse_binary_level(self._parse_multiplicative, ("+", "-"))

    def _parse_multiplicative(self) -> Node:
        return self._parse_binary_level(self._parse_cast, ("*", "/", "%"))

    def _parse_cast(self) -> Node:
        token = self._current
        if token.kind is TokenKind.LPAREN and self._tokens[self._index + 1].kind is TokenKind.IDENT:
            self._advance()  # 消费 '('
            words: list[str] = []
            while self._current.kind is TokenKind.IDENT:
                words.append(self._advance().text)
            rparen = self._current
            if rparen.kind is not TokenKind.RPAREN:
                raise ParseError(f"expected ')' at offset {rparen.pos}")
            self._advance()
            return Cast(_parse_type_name(words), self._parse_cast())
        return self._parse_unary()

    def _parse_unary(self) -> Node:
        if self._at_op("+", "-", "~", "!"):
            op = self._advance().text
            return Unary(op, self._parse_cast())
        return self._parse_primary()

    def _parse_primary(self) -> Node:
        token = self._current
        if token.kind is TokenKind.INT_LITERAL:
            self._advance()
            return _parse_literal(token)
        if token.kind is TokenKind.LPAREN:
            self._advance()
            node = self._parse_conditional()
            rparen = self._current
            if rparen.kind is not TokenKind.RPAREN:
                raise ParseError(f"expected ')' at offset {rparen.pos}")
            self._advance()
            return node
        raise ParseError(f"unexpected token {token.text!r} at offset {token.pos}")


def parse(text: str) -> Node:
    try:
        tokens = tokenize(text)
    except LexError as exc:
        raise ParseError(str(exc)) from exc
    parser = _Parser(tokens)
    node = parser.parse_expression()
    tail = parser._current
    if tail.kind is not TokenKind.EOF:
        raise ParseError(f"unexpected trailing token {tail.text!r} at offset {tail.pos}")
    return node
