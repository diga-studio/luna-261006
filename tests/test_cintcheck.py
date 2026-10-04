"""Automated tests for the C integer constant-expression checker."""

import pytest

from cintcheck import check_expression


def ok(expr):
    r = check_expression(expr)
    assert r.ok, f"{expr!r} unexpectedly reported {[v.kind for v in r.violations]}"
    return r.value, r.type.name


def bad(expr, kind):
    r = check_expression(expr)
    assert not r.ok, f"{expr!r} unexpectedly evaluated to {r.value}"
    assert r.value is None and r.type is None
    assert any(v.kind == kind for v in r.violations)


class TestRequiredScenarios:
    def test_unsigned_short_product_signed_overflow(self):
        # Both operands promote to int; 65535*65535 overflows int.
        bad("(unsigned short)65535*(unsigned short)65535", "signed-overflow")

    def test_hex_wraps_to_unsigned_zero(self):
        # 0xffffffff is unsigned int; +1 wraps modulo 2**32.
        assert ok("0xffffffff+1") == (0, "unsigned int")

    def test_short_circuit_suppresses_division(self):
        assert ok("0 && (1 / 0)") == (0, "int")

    def test_conditional_suppresses_unevaluated_branch(self):
        # Unevaluated branch has an illegal shift; result type still int.
        assert ok("1 ? 42 : (1 << 32)") == (42, "int")

    def test_conditional_result_type_from_both_branches(self):
        # The selected branch's value converts to the common type (long),
        # even though the unselected branch contains an illegal shift.
        assert ok("1 ? (long)7 : (1 << 32)") == (7, "long")


class TestLiteralTyping:
    @pytest.mark.parametrize(
        "expr,expected",
        [
            ("2147483647", "int"),
            ("2147483648", "long long"),  # long is 32-bit on this platform
            ("9223372036854775807", "long long"),
            ("0x7fffffff", "int"),
            ("0x80000000", "unsigned int"),
            ("0xffffffff", "unsigned int"),
            ("0x100000000", "long long"),  # exceeds 32-bit unsigned long
            ("4294967295", "long long"),  # decimal: no unsigned candidates
            ("020000000000", "unsigned int"),  # octal 2**31: int cannot hold it
            ("037777777777", "unsigned int"),
            ("1u", "unsigned int"),
            ("1l", "long"),
            ("1ll", "long long"),
            ("1ul", "unsigned long"),
            ("1ull", "unsigned long long"),
            ("0xffffffffull", "unsigned long long"),
        ],
    )
    def test_literal_types(self, expr, expected):
        assert ok(expr)[1] == expected


class TestArithmeticViolations:
    def test_signed_add_overflow(self):
        bad("2147483647 + 1", "signed-overflow")

    def test_signed_mul_overflow(self):
        bad("46341 * 46341", "signed-overflow")

    def test_signed_negation_overflow(self):
        bad("-(-2147483647 - 1)", "signed-overflow")

    def test_division_by_zero(self):
        bad("1 / 0", "division-by-zero")

    def test_remainder_by_zero(self):
        bad("1 % 0", "division-by-zero")

    def test_min_divided_by_minus_one(self):
        bad("(-2147483647 - 1) / -1", "signed-overflow")

    def test_min_remainder_minus_one(self):
        bad("(-2147483647 - 1) % -1", "signed-overflow")

    def test_unsigned_wrap_is_fine(self):
        assert ok("0u - 1u") == (4294967295, "unsigned int")

    def test_long_long_overflow(self):
        bad("9223372036854775807ll + 1ll", "signed-overflow")


class TestShifts:
    def test_negative_shift_count(self):
        bad("1 << -1", "invalid-shift")

    def test_oversized_shift_count(self):
        bad("1 << 32", "invalid-shift")

    def test_shift_count_uses_promoted_left_width(self):
        # (char)1 promotes to int: 32-bit width, so << 31 is representable.
        assert ok("(char)1 << 30") == (1 << 30, "int")

    def test_negative_left_shift(self):
        bad("-1 << 1", "invalid-shift")

    def test_unrepresentable_left_shift(self):
        bad("1 << 31", "signed-overflow")

    def test_unsigned_left_shift_wraps(self):
        assert ok("0x80000000u << 1") == (0, "unsigned int")

    def test_negative_right_shift_sign_extends(self):
        assert ok("-8 >> 2") == (-2, "int")

    def test_unsigned_right_shift_is_logical(self):
        assert ok("0x80000000u >> 31") == (1, "unsigned int")

    def test_shift_result_type_from_left_operand(self):
        assert ok("1ll << 40")[1] == "long long"


class TestConversionsAndSemantics:
    def test_truncating_division(self):
        assert ok("-7 / 2") == (-3, "int")
        assert ok("7 / -2") == (-3, "int")

    def test_remainder_sign_follows_dividend(self):
        assert ok("-7 % 2") == (-1, "int")
        assert ok("7 % -2") == (1, "int")

    def test_cast_to_signed_keeps_low_bits(self):
        assert ok("(int)0xffffffffu") == (-1, "int")

    def test_cast_narrows(self):
        assert ok("(char)257") == (1, "char")

    def test_usual_arithmetic_conversion(self):
        assert ok("1 + 1u")[1] == "unsigned int"
        assert ok("1u + 1l")[1] == "unsigned long"
        assert ok("1u + 1ll")[1] == "long long"

    def test_comparison_and_bitwise(self):
        assert ok("(3 & 1) | 4 ^ 1") == (5, "int")  # & > ^ > |
        assert ok("5 > 4") == (1, "int")
        assert ok("5 == 6") == (0, "int")
        assert ok("~0") == (-1, "int")
        assert ok("!5") == (0, "int")

    def test_short_circuit_or(self):
        assert ok("1 || (1 << 32)") == (1, "int")

    def test_violation_in_evaluated_operand_still_reported(self):
        bad("(1 / 0) && 0", "division-by-zero")
        bad("0 ? 1 : (1 % 0)", "division-by-zero")

    def test_precedence_and_associativity(self):
        assert ok("1 + 2 * 3 - 4 / 2") == (5, "int")
        assert ok("10 - 4 - 3") == (3, "int")
        assert ok("1 << 2 + 1") == (8, "int")  # + binds tighter than <<
