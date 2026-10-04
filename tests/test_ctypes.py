"""类型系统单元测试：提升、通常算术转换、值转换、字面量类型。"""

from cconst.ctypes import (
    INT, LLONG, LONG, SCHAR, UCHAR, UINT, ULONG, ULLONG, USHORT,
    convert_value, integer_promote, literal_type, usual_arithmetic_conversion,
)


class TestIntegerPromote:
    def test_small_types_promote_to_int(self):
        assert integer_promote(SCHAR) is INT
        assert integer_promote(UCHAR) is INT
        assert integer_promote(USHORT) is INT  # 本平台 int 为 32 位，可表示 unsigned short

    def test_int_and_above_unchanged(self):
        for ctype in (INT, UINT, LONG, ULONG, LLONG, ULLONG):
            assert integer_promote(ctype) is ctype


class TestUsualArithmeticConversion:
    def test_same_type(self):
        assert usual_arithmetic_conversion(UINT, UINT) is UINT

    def test_same_signedness_higher_rank_wins(self):
        assert usual_arithmetic_conversion(INT, LLONG) is LLONG
        assert usual_arithmetic_conversion(UINT, ULLONG) is ULLONG

    def test_unsigned_same_rank_wins(self):
        assert usual_arithmetic_conversion(INT, UINT) is UINT
        assert usual_arithmetic_conversion(LONG, ULONG) is ULONG

    def test_signed_higher_rank_that_cannot_represent(self):
        # long 与 unsigned int 同为 32 位：结果为 unsigned long
        assert usual_arithmetic_conversion(LONG, UINT) is ULONG

    def test_signed_higher_rank_that_can_represent(self):
        # 64 位 long long 可表示 unsigned int / unsigned long 全部值
        assert usual_arithmetic_conversion(LLONG, UINT) is LLONG
        assert usual_arithmetic_conversion(LLONG, ULONG) is LLONG

    def test_unsigned_higher_or_equal_rank(self):
        assert usual_arithmetic_conversion(ULLONG, LLONG) is ULLONG


class TestConvertValue:
    def test_unsigned_wraps_modulo(self):
        assert convert_value(0xFFFFFFFF + 1, UINT) == 0
        assert convert_value(-1, UINT) == 0xFFFFFFFF

    def test_signed_keeps_low_bits_two_complement(self):
        assert convert_value(0xFFFFFFFF, INT) == -1
        assert convert_value(0x80000000, INT) == -2147483648
        assert convert_value(65535, SCHAR) == -1

    def test_in_range_unchanged(self):
        assert convert_value(123, INT) == 123
        assert convert_value(-123, INT) == -123


class TestLiteralType:
    def test_decimal_no_suffix_signed_only(self):
        assert literal_type(2147483647, 10, "") is INT
        # 本平台 long 为 32 位，超出 int 的十进制无后缀字面量落到 long long
        assert literal_type(2147483648, 10, "") is LLONG
        assert literal_type(9223372036854775807, 10, "") is LLONG

    def test_hex_octal_no_suffix_allow_unsigned(self):
        assert literal_type(0x7FFFFFFF, 16, "") is INT
        assert literal_type(0x80000000, 16, "") is UINT
        assert literal_type(0xFFFFFFFF, 16, "") is UINT
        assert literal_type(0x100000000, 16, "") is LLONG
        assert literal_type(0xFFFFFFFFFFFFFFFF, 16, "") is ULLONG
        assert literal_type(0o37777777777, 8, "") is UINT  # 八进制 2^32-1

    def test_suffixes(self):
        assert literal_type(1, 10, "u") is UINT
        assert literal_type(0xFFFFFFFF, 16, "u") is UINT
        assert literal_type(0x100000000, 16, "u") is ULLONG  # 超出 32 位 unsigned long
        assert literal_type(1, 10, "l") is LONG
        assert literal_type(0x80000000, 16, "l") is ULONG
        assert literal_type(1, 10, "ll") is LLONG
        assert literal_type(0xFFFFFFFFFFFFFFFF, 16, "ll") is ULLONG
        assert literal_type(1, 10, "lu") is ULONG
        assert literal_type(1, 10, "llu") is ULLONG
