# task26100615

C 整数常量表达式合规检查库（纯内存，无任何外部服务依赖）。

## 用法

```python
from cconst import check_expression

result = check_expression("(unsigned short)65535*(unsigned short)65535")
# result.ok == False，result.violations 含 signed-overflow

result = check_expression("0xffffffff+1")
# result.ok == True，result.value == 0，result.ctype 为 unsigned int
```

- `check_expression(text) -> CheckResult`：输入上层扫描器提取的完整常量表达式文本。
- `CheckResult.ok` 为 `True` 时，`value`/`ctype` 为求值结果；为 `False` 时
  `violations` 非空，违规表达式不会以正常值返回。

## 语义约定

- C11 整数语义；char=8（有符号）、short=16、int/long=32、long long=64，二补码。
- 支持十/八/十六进制字面量与 C11 整数后缀，按 6.4.4.1 候选类型顺序确定类型。
- 支持括号、整数强转、一元 `+ - ~ !`、四则、取余、移位、比较、按位、
  短路 `&&`/`||`、条件运算 `?:`。
- 违规：有符号算术越界、除/余零除数、最小有符号数除以或取余 -1、
  移位量为负或不小于提升后左操作数位宽、有符号负数左移、
  有符号左移结果不可表示。
- 无符号运算按位宽取模、转换按低位保留解释，均不算违规。
- 短路逻辑与条件运算只检查实际求值的操作数；条件运算结果类型仍由两支共同确定。

## 结构

- `cconst/ctypes.py`：类型系统（提升、通常算术转换、值转换、字面量类型）
- `cconst/lexer.py`：词法分析
- `cconst/parser.py`：递归下降语法分析，生成 AST
- `cconst/evaluator.py`：求值与违规检测
- `cconst/api.py`：对外接口

## 测试

```sh
python3 -m pytest tests/ -q
```
