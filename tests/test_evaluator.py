"""求值与违规检测集成测试（经由对外接口 check_expression）。"""

import pytest

from cconst import check_expression
from cconst.api import ParseError
from cconst.ctypes import INT, LLONG, UINT, ULLONG


def kinds(result):
    return {v.kind for v in result.violations}


class TestRequiredScenarios:
    """任务书要求的场景。"""

    def test_unsigned_short_product_signed_overflow(self):
        # (unsigned short)65535 提升为 int，65535*65535 超出 int 范围
        result = check_expression("(unsigned short)65535*(unsigned short)65535")
        assert not result.ok
        assert result.value is None and result.ctype is None
        assert "signed-overflow" in kinds(result)

    def test_hex_max_plus_one_wraps_to_unsigned_zero(self):
        # 0xffffffff 类型为 unsigned int，+1 按 32 位取模得 0，不算违规
        result = check_expression("0xffffffff+1")
        assert result.ok
        assert result.value == 0
        assert result.ctype is UINT

    def test_short_circuit_and_suppresses_division(self):
        result = check_expression("0 && (1 / 0)")
        assert result.ok
        assert result.value == 0
        assert result.ctype is INT

    def test_short_circuit_or_suppresses_division(self):
        result = check_expression("1 || (1 / 0)")
        assert result.ok
        assert result.value == 1

    def test_conditional_suppresses_unevaluated_branch(self):
        # 未选中分支含非法移位，不得报告违规
        result = check_expression("1 ? 42 : (1 << 100)")
        assert result.ok
        assert result.value == 42

    def test_conditional_result_type_from_both_branches(self):
        # 违规抑制不影响结果类型判断：选中分支的值须转换到公共类型
        result = check_expression("1 ? 1u : (1 << 100)")
        assert result.ok
        assert result.ctype is UINT
        assert result.value == 1

    def test_conditional_selected_value_converted_to_result_type(self):
        # 选中分支 -1 转换到公共类型 unsigned int
        result = check_expression("1 ? -1 : (0xffffffffu + 1 - 1)")
        assert result.ok
        assert result.ctype is UINT
        assert result.value == 0xFFFFFFFF


class TestSignedOverflow:
    @pytest.mark.parametrize("expr", [
        "2147483647 + 1",
        "-2147483647 - 2",
        "2147483647 * 2",
        "65536 * 65536",
        "-(-2147483647 - 1)",       # 一元负号作用于 int 最小值
        "(int)2147483647 + 1",
    ])
    def test_signed_overflow_reported(self, expr):
        result = check_expression(expr)
        assert not result.ok
        assert "signed-overflow" in kinds(result)

    @pytest.mark.parametrize("expr,value", [
        ("2147483646 + 1", 2147483647),
        ("-2147483647 - 1", -2147483648),
        ("(short)32767 + (short)1", 32768),   # 提升为 int 后不溢出
        ("0x7fffffff + 0", 2147483647),
    ])
    def test_signed_in_range_ok(self, expr, value):
        result = check_expression(expr)
        assert result.ok
        assert result.value == value

    def test_unsigned_wrap_not_violation(self):
        result = check_expression("0xffffffffu + 0xffffffffu")
        assert result.ok
        assert result.value == 0xFFFFFFFE
        assert result.ctype is UINT


class TestDivisionAndRemainder:
    @pytest.mark.parametrize("expr", ["1 / 0", "1 % 0", "1 / (1 - 1)"])
    def test_zero_divisor(self, expr):
        result = check_expression(expr)
        assert not result.ok
        assert "division-by-zero" in kinds(result)

    @pytest.mark.parametrize("expr", [
        "(-2147483647 - 1) / -1",
        "(-2147483647 - 1) % -1",
    ])
    def test_min_divided_by_minus_one(self, expr):
        result = check_expression(expr)
        assert not result.ok
        assert "signed-overflow" in kinds(result)

    @pytest.mark.parametrize("expr,value", [
        ("-7 / 2", -3),     # 向零截断
        ("7 / -2", -3),
        ("-7 % 2", -1),     # 余数与被除数同号
        ("7 % -2", 1),
        ("-6 % 3", 0),
    ])
    def test_truncation_and_remainder_sign(self, expr, value):
        result = check_expression(expr)
        assert result.ok
        assert result.value == value


class TestShifts:
    @pytest.mark.parametrize("expr", [
        "1 << -1",
        "1 << 32",          # 不小于提升后左操作数位宽
        "1 >> 32",
        "1ll << 64",
    ])
    def test_invalid_shift_amount(self, expr):
        result = check_expression(expr)
        assert not result.ok
        assert "invalid-shift-amount" in kinds(result)

    def test_negative_left_shift(self):
        result = check_expression("-1 << 1")
        assert not result.ok
        assert "signed-overflow" in kinds(result)

    def test_left_shift_result_not_representable(self):
        result = check_expression("1 << 31")
        assert not result.ok
        assert "signed-overflow" in kinds(result)

    @pytest.mark.parametrize("expr,value,ctype", [
        ("1 << 30", 1 << 30, INT),
        ("1u << 31", 0x80000000, UINT),          # 无符号左移取模，不违规
        ("0xffffffffu << 4", 0xFFFFFFF0, UINT),
        ("1ll << 62", 1 << 62, LLONG),
        ("-4 >> 1", -2, INT),                    # 有符号负数右移补符号位
        ("(-2147483647 - 1) >> 31", -1, INT),
        ("(unsigned char)0xff << 1", 510, INT),  # 移位结果类型由提升后左操作数决定
    ])
    def test_valid_shifts(self, expr, value, ctype):
        result = check_expression(expr)
        assert result.ok
        assert result.value == value
        assert result.ctype is ctype


class TestCastsAndConversions:
    def test_narrowing_cast_not_violation(self):
        result = check_expression("(signed char)255")
        assert result.ok
        assert result.value == -1

    def test_cast_to_unsigned(self):
        result = check_expression("(unsigned)-1")
        assert result.ok
        assert result.value == 0xFFFFFFFF
        assert result.ctype is UINT

    def test_multiword_type_names(self):
        result = check_expression("(unsigned long long)-1")
        assert result.ok
        assert result.value == 0xFFFFFFFFFFFFFFFF
        assert result.ctype is ULLONG

    def test_mixed_sign_comparison(self):
        # -1 转换为 unsigned int 后为最大值
        result = check_expression("-1 < 1u")
        assert result.ok
        assert result.value == 0


class TestLogicalAndConditional:
    @pytest.mark.parametrize("expr,value", [
        ("1 && 2", 1),
        ("2 || 0", 1),
        ("!5", 0),
        ("!0", 1),
        ("~0", -1),
        ("1 ? 2 : 3", 2),
        ("0 ? 2 : 3", 3),
    ])
    def test_values(self, expr, value):
        result = check_expression(expr)
        assert result.ok
        assert result.value == value

    def test_violation_in_evaluated_branch_reported(self):
        result = check_expression("1 ? (1 / 0) : 2")
        assert not result.ok
        assert "division-by-zero" in kinds(result)

    def test_violation_in_condition_reported(self):
        result = check_expression("(1 / 0) ? 2 : 3")
        assert not result.ok

    def test_multiple_violations_may_be_reported(self):
        result = check_expression("(1 / 0) + (2147483647 + 1)")
        assert not result.ok
        assert kinds(result) == {"division-by-zero", "signed-overflow"}


class TestPrecedenceAndAssociativity:
    @pytest.mark.parametrize("expr,value", [
        ("2 + 3 * 4", 14),
        ("(2 + 3) * 4", 20),
        ("16 - 4 - 2", 10),          # 左结合
        ("1 << 2 + 1", 8),           # + 优先于 <<
        ("1 + 2 << 3", 24),
        ("1 | 2 ^ 3 & 1", 3),        # & > ^ > |
        ("1 == 1 < 2", 1),           # < 优先于 ==
        ("!1 + 1", 1),
        ("-2 * -3", 6),
        ("1 ? 2 : 0 ? 3 : 4", 2),    # 条件运算右结合
    ])
    def test_precedence(self, expr, value):
        result = check_expression(expr)
        assert result.ok
        assert result.value == value


class TestLiteralForms:
    @pytest.mark.parametrize("expr,value", [
        ("0", 0),
        ("017", 15),
        ("0o17" if False else "0x1F", 31),
        ("0X1FUL", 31),
        ("1llu", 1),
        ("010 + 0x10 + 10", 34),
    ])
    def test_literal_forms(self, expr, value):
        result = check_expression(expr)
        assert result.ok
        assert result.value == value

    def test_invalid_syntax_raises(self):
        with pytest.raises(ParseError):
            check_expression("1 +")
