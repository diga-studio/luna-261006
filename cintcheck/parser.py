"""Recursive-descent parser producing an AST with C11 precedence/associativity."""

from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional

from .lexer import Token

_TYPE_KEYWORDS = {"signed", "unsigned", "char", "short", "int", "long"}


@dataclass(frozen=True)
class Node:
    kind: str  # 'num', 'cast', 'unary', 'binary', 'cond'
    op: str = ""  # operator for unary/binary
    text: str = ""  # literal text for num
    ctype: str = ""  # target type name for cast
    left: Optional["Node"] = None
    right: Optional["Node"] = None
    third: Optional["Node"] = None  # else-branch for cond


class _Parser:
    def __init__(self, tokens: List[Token]):
        self.tokens = tokens
        self.pos = 0

    def peek(self) -> Token:
        return self.tokens[self.pos]

    def next(self) -> Token:
        tok = self.tokens[self.pos]
        self.pos += 1
        return tok

    def expect_op(self, op: str) -> None:
        tok = self.next()
        if tok.kind != "op" or tok.text != op:
            raise ValueError(f"expected {op!r}, got {tok.text!r}")

    # conditional-expression (right-associative)
    def conditional(self) -> Node:
        cond = self.logical_or()
        if self.peek().kind == "question":
            self.next()
            then = self.conditional()
            tok = self.next()
            if tok.kind != "colon":
                raise ValueError(f"expected ':', got {tok.text!r}")
            els = self.conditional()
            return Node("cond", left=cond, right=then, third=els)
        return cond

    def _left_assoc(self, sub, ops) -> Node:
        node = sub()
        while self.peek().kind == "op" and self.peek().text in ops:
            op = self.next().text
            rhs = sub()
            node = Node("binary", op=op, left=node, right=rhs)
        return node

    def logical_or(self) -> Node:
        return self._left_assoc(self.logical_and, ("||",))

    def logical_and(self) -> Node:
        return self._left_assoc(self.inclusive_or, ("&&",))

    def inclusive_or(self) -> Node:
        return self._left_assoc(self.exclusive_or, ("|",))

    def exclusive_or(self) -> Node:
        return self._left_assoc(self.and_expr, ("^",))

    def and_expr(self) -> Node:
        return self._left_assoc(self.equality, ("&",))

    def equality(self) -> Node:
        return self._left_assoc(self.relational, ("==", "!="))

    def relational(self) -> Node:
        return self._left_assoc(self.shift, ("<", ">", "<=", ">="))

    def shift(self) -> Node:
        return self._left_assoc(self.additive, ("<<", ">>"))

    def additive(self) -> Node:
        return self._left_assoc(self.multiplicative, ("+", "-"))

    def multiplicative(self) -> Node:
        return self._left_assoc(self.cast, ("*", "/", "%"))

    def cast(self) -> Node:
        if self.peek().kind == "lparen" and self._is_cast_ahead():
            self.next()  # '('
            parts = []
            while self.peek().kind == "ident" and self.peek().text in _TYPE_KEYWORDS:
                parts.append(self.next().text)
            tok = self.next()
            if tok.kind != "rparen":
                raise ValueError(f"expected ')' after cast type, got {tok.text!r}")
            operand = self.cast()
            return Node("cast", ctype=" ".join(parts), left=operand)
        return self.unary()

    def _is_cast_ahead(self) -> bool:
        # '(' already peeked; a cast starts with a type keyword.
        return (
            self.tokens[self.pos + 1].kind == "ident"
            and self.tokens[self.pos + 1].text in _TYPE_KEYWORDS
        )

    def unary(self) -> Node:
        tok = self.peek()
        if tok.kind == "op" and tok.text in ("+", "-", "~", "!"):
            self.next()
            operand = self.cast()
            return Node("unary", op=tok.text, left=operand)
        return self.primary()

    def primary(self) -> Node:
        tok = self.next()
        if tok.kind == "num":
            return Node("num", text=tok.text)
        if tok.kind == "lparen":
            node = self.conditional()
            closing = self.next()
            if closing.kind != "rparen":
                raise ValueError(f"expected ')', got {closing.text!r}")
            return node
        raise ValueError(f"unexpected token {tok.text!r}")


def parse(tokens: List[Token]) -> Node:
    parser = _Parser(tokens)
    node = parser.conditional()
    if parser.peek().kind != "eof":
        raise ValueError(f"trailing token {parser.peek().text!r}")
    return node
